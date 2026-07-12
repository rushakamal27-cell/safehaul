/**
 * app/api/sync/samsara-safety-events/route.ts
 *
 * Phase 5A: Samsara Safety Events Stream Sync
 *
 * Triggered by Vercel Cron every 5 minutes (vercel.json). Can also be called
 * manually for testing via GET with Authorization: Bearer $CRON_SECRET.
 *
 * Flow:
 *   1. Verify CRON_SECRET
 *   2. Fetch active pilot driver external IDs → Samsara driverIds pre-filter
 *      (skips API call entirely if no pilot drivers are configured)
 *   3. Load stream cursor from ProviderSyncState
 *      (cold start: bootstrap from COLD_START_HOURS ago when no cursor exists)
 *   4. Drain all pages from Samsara Safety Events Stream
 *      Loop until hasNextPage = false:
 *        a. Fetch one page
 *        b. For each event:
 *             i.  normalizeStreamEvent() → NormalizedProviderEvent | null
 *             ii. Dedup via RawProviderEvent.@@unique([provider, externalEventId])
 *                 — same P2002 optimistic strategy as the webhook route
 *             iii.If new: look up DriverProviderMapping, check isPilot + isActive,
 *                 create DriverEvent
 *        c. Persist cursor after each page (safe checkpoint; re-fetch on crash)
 *   5. Return sync summary
 *
 * Deduplication guarantee:
 *   RawProviderEvent.@@unique([provider, externalEventId]) deduplicates across
 *   ingestion channels. An event delivered by BOTH webhook and stream produces
 *   exactly one RawProviderEvent and one DriverEvent regardless of order.
 *
 * Cursor safety:
 *   Cursor is written after each page succeeds. A Vercel timeout or DB failure
 *   mid-drain causes re-processing of the current page on the next cron tick;
 *   RawProviderEvent dedup absorbs the overlap without creating duplicate DriverEvents.
 *
 * Stale cursor handling:
 *   Samsara returns 4xx for an expired cursor. On detection, the cursor is cleared
 *   and the next run bootstraps fresh from COLD_START_HOURS ago.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  fetchSamsaraSafetyEvents,
  SamsaraApiError,
} from "@/lib/providers/samsara/safetyEventsStream";
import {
  normalizeSafetyStreamEvent,
  type StreamSkipReason,
} from "@/lib/providers/samsara/normalizeStreamEvent";

const PROVIDER = "samsara" as const;
const STREAM_KEY = "safety-events" as const;
const COLD_START_HOURS = 24;

function verifyCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[sync/samsara] CRON_SECRET env var is not set");
    return false;
  }
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  // ── Step 1: Auth ──────────────────────────────────────────────────────────
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  // ── Step 2: Fetch pilot driver IDs for Samsara-side pre-filtering ─────────
  // Only events for these drivers are fetched — avoids processing the entire fleet.
  let pilotDriverIds: string[] = [];
  try {
    const mappings = await prisma.driverProviderMapping.findMany({
      where: { provider: PROVIDER, isPilot: true, isActive: true },
      select: { externalDriverId: true },
    });
    pilotDriverIds = mappings.map((m) => m.externalDriverId);
  } catch (err) {
    console.error("[sync/samsara] Failed to fetch pilot driver mappings:", err);
    return NextResponse.json(
      { error: "Failed to load pilot driver list" },
      { status: 500 }
    );
  }

  if (pilotDriverIds.length === 0) {
    console.info(
      "[sync/samsara] No active pilot drivers configured — skipping sync"
    );
    return NextResponse.json({
      synced: true,
      skipped: true,
      reason: "no_pilot_drivers",
      elapsedMs: Date.now() - startedAt,
    });
  }

  // ── Step 3: Load stream cursor ────────────────────────────────────────────
  let afterCursor: string | undefined;
  let startTime: string | undefined;

  try {
    const state = await prisma.providerSyncState.findUnique({
      where: {
        provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
      },
    });

    if (state?.cursor) {
      afterCursor = state.cursor;
    } else {
      const coldStartTime = new Date(
        Date.now() - COLD_START_HOURS * 60 * 60 * 1000
      );
      startTime = coldStartTime.toISOString();
      console.info(
        `[sync/samsara] No cursor found — cold-start bootstrap from ${startTime}`
      );
    }
  } catch (err) {
    console.error("[sync/samsara] Failed to load sync state:", err);
    return NextResponse.json(
      { error: "Failed to load sync cursor" },
      { status: 500 }
    );
  }

  // ── Steps 4: Drain pages ──────────────────────────────────────────────────
  let pagesProcessed = 0;
  let eventsProcessed = 0;
  let eventsSkipped = 0; // unsupported type, missing driver, or missing timestamp
  let duplicates = 0;
  let driverEventsCreated = 0;
  let lastCursor: string | undefined;
  const skipReasons: Record<StreamSkipReason, number> = {
    no_driver_id: 0,
    unsupported_behavior_label: 0,
    no_timestamp: 0,
    unexpected_error: 0,
  };
  const unsupportedLabelCounts: Record<string, number> = {};

  try {
    let hasNextPage = true;
    let currentCursor = afterCursor;

    while (hasNextPage) {
      // 4a. Fetch one page
      const page = await fetchSamsaraSafetyEvents({
        afterCursor: currentCursor,
        startTime: currentCursor ? undefined : startTime,
        driverIds: pilotDriverIds,
      });

      pagesProcessed++;
      lastCursor = page.pagination.endCursor;
      hasNextPage = page.pagination.hasNextPage;
      currentCursor = page.pagination.endCursor;

      // 4b. Process each event on this page
      for (const rawEvent of page.data) {
        eventsProcessed++;

        // externalEventId is always set for stream events (event.id is required by schema)
        const externalEventId = rawEvent.id;

        // Dedup check: optimistic findUnique first, then create with P2002 catch.
        // This now happens BEFORE normalization — the raw payload is preserved
        // regardless of whether normalization later succeeds, so unsupported
        // events remain available for replay once new labels are supported.
        let rawProviderEventId: string | undefined;
        let isDuplicate = false;

        const existing = await prisma.rawProviderEvent.findUnique({
          where: {
            provider_externalEventId: {
              provider: PROVIDER,
              externalEventId,
            },
          },
          select: { id: true },
        });

        if (existing) {
          isDuplicate = true;
          duplicates++;
        } else {
          try {
            const raw = await prisma.rawProviderEvent.create({
              data: {
                provider:        PROVIDER,
                source:          "stream",
                externalEventId,
                rawPayload:      rawEvent as object,
                receivedAt:      new Date(),
              },
              select: { id: true },
            });
            rawProviderEventId = raw.id;
          } catch (createErr: unknown) {
            // P2002 = race between two simultaneous cron invocations (rare but possible)
            if (
              typeof createErr === "object" &&
              createErr !== null &&
              (createErr as { code?: string }).code === "P2002"
            ) {
              isDuplicate = true;
              duplicates++;
            } else {
              console.error(
                `[sync/samsara] Failed to create RawProviderEvent for event id="${rawEvent.id}":`,
                createErr
              );
              continue;
            }
          }
        }

        if (isDuplicate || !rawProviderEventId) continue;

        // Normalize — returns { event: null, skipReason, ... } for unsupported
        // labels, missing driver ID, or missing timestamp. The RawProviderEvent
        // row created above is kept either way.
        const normalized = normalizeSafetyStreamEvent(rawEvent);

        if (!normalized.event) {
          eventsSkipped++;
          const reason = normalized.skipReason ?? "unexpected_error";
          skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;

          if (reason === "unsupported_behavior_label") {
            for (const label of normalized.observedLabels ?? []) {
              unsupportedLabelCounts[label] = (unsupportedLabelCounts[label] ?? 0) + 1;
            }
          }

          // Structured, greppable skip log — no secrets, no full payload.
          console.warn(
            JSON.stringify({
              msg:              "sync_skip",
              reason,
              externalEventId,
              externalDriverId: normalized.externalDriverId ?? rawEvent.driver?.id ?? null,
              timestamp:        rawEvent.startMs ?? rawEvent.createdAtTime ?? null,
              labels:           normalized.observedLabels ?? [],
            })
          );
          continue;
        }

        // Resolve pilot driver mapping and create DriverEvent
        try {
          const mapping = await prisma.driverProviderMapping.findUnique({
            where: {
              provider_externalDriverId: {
                provider:         PROVIDER,
                externalDriverId: normalized.event.externalDriverId,
              },
            },
            select: { driverId: true, isPilot: true, isActive: true },
          });

          if (!mapping) {
            // Should not happen since we pre-filtered by pilot driver IDs, but guard anyway
            console.info(
              `[sync/samsara] No mapping for externalDriverId="${normalized.event.externalDriverId}" — skipping`
            );
            continue;
          }

          if (!mapping.isActive || !mapping.isPilot) {
            // Mapping may have been deactivated between the prefetch and now
            continue;
          }

          await prisma.driverEvent.create({
            data: {
              driverId:           mapping.driverId,
              rawProviderEventId,
              provider:           PROVIDER,
              externalDriverId:   normalized.event.externalDriverId,
              externalVehicleId:  normalized.event.externalVehicleId ?? null,
              type:               normalized.event.type,
              severity:           normalized.event.severity,
              timestamp:          new Date(normalized.event.timestamp),
              lat:                normalized.event.lat ?? null,
              lng:                normalized.event.lng ?? null,
            },
          });

          driverEventsCreated++;
        } catch (err) {
          // Per-event error: log and continue — do not fail the whole sync run
          console.error(
            `[sync/samsara] Failed to create DriverEvent for event id="${rawEvent.id}":`,
            err
          );
        }
      }

      // 4c. Persist cursor after each page — safe checkpoint
      // On crash/timeout, next run re-fetches this page; dedup absorbs the overlap.
      await prisma.providerSyncState.upsert({
        where: {
          provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
        },
        update: { cursor: lastCursor, lastSyncAt: new Date() },
        create: {
          provider:   PROVIDER,
          streamKey:  STREAM_KEY,
          cursor:     lastCursor,
          lastSyncAt: new Date(),
        },
      });
    }
  } catch (err) {
    const isStale =
      err instanceof SamsaraApiError &&
      (err.status === 400 || err.status === 422);

    if (isStale) {
      // Expired cursor — reset so next run bootstraps from COLD_START_HOURS ago
      console.warn(
        `[sync/samsara] Stale cursor (${(err as SamsaraApiError).status}) — clearing cursor for fresh bootstrap`
      );
      await prisma.providerSyncState
        .upsert({
          where: {
            provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
          },
          update:  { cursor: null },
          create: { provider: PROVIDER, streamKey: STREAM_KEY, cursor: null },
        })
        .catch((resetErr: unknown) =>
          console.error("[sync/samsara] Failed to reset cursor:", resetErr)
        );
    } else {
      console.error("[sync/samsara] Sync failed:", err);
    }

    return NextResponse.json(
      {
        synced:             false,
        error:              err instanceof Error ? err.message : "Unknown error",
        pagesProcessed,
        eventsProcessed,
        eventsSkipped,
        skipReasons,
        unsupportedLabelsFound: unsupportedLabelCounts,
        duplicates,
        driverEventsCreated,
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    synced:             true,
    pagesProcessed,
    eventsProcessed,
    eventsSkipped,
    skipReasons,
    unsupportedLabelsFound: unsupportedLabelCounts,
    duplicates,
    driverEventsCreated,
    cursor:             lastCursor,
    elapsedMs:          Date.now() - startedAt,
  });
}

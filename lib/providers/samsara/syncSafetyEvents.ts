/**
 * lib/providers/samsara/syncSafetyEvents.ts
 *
 * Core Samsara Safety Events Stream sync operation, extracted so it can be
 * called two ways:
 *   1. GET /api/sync/samsara-safety-events — CRON_SECRET-authenticated,
 *      kept for manual/ops use now that the 5-minute cron has been removed
 *      (Hobby plan cannot run it reliably).
 *   2. lib/providers/samsara/onDemandSync.ts — called in-process from
 *      /api/risk to refresh stale pilot data before scoring, with no HTTP
 *      round-trip back to our own deployment.
 *
 * Flow:
 *   1. Fetch active pilot driver external IDs → Samsara driverIds pre-filter
 *      (skips API call entirely if no pilot drivers are configured)
 *   2. Load stream cursor from ProviderSyncState
 *      (cold start: bootstrap from COLD_START_HOURS ago when no cursor exists)
 *   3. Drain all pages from Samsara Safety Events Stream
 *      Loop until hasNextPage = false:
 *        a. Fetch one page
 *        b. For each event:
 *             i.  normalizeStreamEvent() → NormalizedProviderEvent | null
 *             ii. Dedup via RawProviderEvent.@@unique([provider, externalEventId])
 *                 — same P2002 optimistic strategy as the webhook route
 *             iii.If new: look up DriverProviderMapping, check isPilot + isActive,
 *                 create DriverEvent
 *        c. Persist cursor after each page (safe checkpoint; re-fetch on crash)
 *   4. Return sync summary
 *
 * Deduplication guarantee:
 *   RawProviderEvent.@@unique([provider, externalEventId]) deduplicates across
 *   ingestion channels. An event delivered by BOTH webhook and stream produces
 *   exactly one RawProviderEvent and one DriverEvent regardless of order.
 *
 * Cursor safety:
 *   Cursor is written after each page succeeds. A timeout, abort, or DB failure
 *   mid-drain causes re-processing of the current page on the next run;
 *   RawProviderEvent dedup absorbs the overlap without creating duplicate DriverEvents.
 *
 * lastSyncAt semantics:
 *   Unlike cursor, lastSyncAt is stamped exactly once — after the full drain
 *   completes with hasNextPage = false — never per-page. This is what callers
 *   (ensureFreshSamsaraSync) use to decide freshness, so a sync that fails or
 *   times out partway through must NOT advance it: doing so would make an
 *   incomplete drain look fresh to the next request. A successful drain that
 *   finds zero new events still advances it (the sync itself succeeded).
 *
 * Stale cursor handling:
 *   Samsara returns 4xx for an expired cursor. On detection, the cursor is cleared
 *   and the next run bootstraps fresh from COLD_START_HOURS ago.
 *
 * Cancellation:
 *   An optional AbortSignal can be passed through to the underlying fetch so a
 *   caller (the on-demand path) can enforce a bounded wait. Aborting mid-page
 *   simply surfaces as a failed sync — the cursor from the last completed page
 *   is already persisted, so no data is lost.
 */

import { prisma } from "@/lib/prisma";
import {
  fetchSamsaraSafetyEvents,
  SamsaraApiError,
} from "@/lib/providers/samsara/safetyEventsStream";
import {
  normalizeSafetyStreamEvent,
  type StreamSkipReason,
} from "@/lib/providers/samsara/normalizeStreamEvent";

export const PROVIDER = "samsara" as const;
export const STREAM_KEY = "safety-events" as const;
const COLD_START_HOURS = 24;

export interface SamsaraSyncStats {
  pagesProcessed: number;
  eventsProcessed: number;
  eventsSkipped: number;
  skipReasons: Record<StreamSkipReason, number>;
  unsupportedLabelsFound: Record<string, number>;
  duplicates: number;
  driverEventsCreated: number;
}

const emptyStats = (): SamsaraSyncStats => ({
  pagesProcessed: 0,
  eventsProcessed: 0,
  eventsSkipped: 0,
  skipReasons: {
    no_driver_id: 0,
    unsupported_behavior_label: 0,
    no_timestamp: 0,
    unexpected_error: 0,
  },
  unsupportedLabelsFound: {},
  duplicates: 0,
  driverEventsCreated: 0,
});

export type SamsaraSyncOutcome =
  | ({ synced: true; skipped: true; reason: "no_pilot_drivers"; elapsedMs: number })
  | ({ synced: true; skipped: false; cursor?: string; elapsedMs: number } & SamsaraSyncStats)
  | ({ synced: false; error: string; elapsedMs: number } & SamsaraSyncStats);

/**
 * Runs one full drain of the Samsara Safety Events Stream for active pilot
 * drivers and persists the results. Safe to call directly from server-side
 * code (no HTTP hop, no CRON_SECRET requirement) — auth is the caller's
 * responsibility.
 */
export async function runSamsaraSafetyEventsSync(
  signal?: AbortSignal
): Promise<SamsaraSyncOutcome> {
  const startedAt = Date.now();

  // ── Step 1: Fetch pilot driver IDs for Samsara-side pre-filtering ─────────
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
    return {
      synced: false,
      error: "Failed to load pilot driver list",
      elapsedMs: Date.now() - startedAt,
      ...emptyStats(),
    };
  }

  if (pilotDriverIds.length === 0) {
    console.info(
      "[sync/samsara] No active pilot drivers configured — skipping sync"
    );
    return {
      synced: true,
      skipped: true,
      reason: "no_pilot_drivers",
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ── Step 2: Load stream cursor ────────────────────────────────────────────
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
    return {
      synced: false,
      error: "Failed to load sync cursor",
      elapsedMs: Date.now() - startedAt,
      ...emptyStats(),
    };
  }

  // ── Step 3: Drain pages ──────────────────────────────────────────────────
  const stats = emptyStats();
  let lastCursor: string | undefined;

  try {
    let hasNextPage = true;
    let currentCursor = afterCursor;

    while (hasNextPage) {
      // 3a. Fetch one page
      const page = await fetchSamsaraSafetyEvents({
        afterCursor: currentCursor,
        startTime: currentCursor ? undefined : startTime,
        driverIds: pilotDriverIds,
        signal,
      });

      stats.pagesProcessed++;
      lastCursor = page.pagination.endCursor;
      hasNextPage = page.pagination.hasNextPage;
      currentCursor = page.pagination.endCursor;

      // 3b. Process each event on this page
      for (const rawEvent of page.data) {
        stats.eventsProcessed++;

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
          stats.duplicates++;
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
            // P2002 = race between two simultaneous sync invocations (rare but possible)
            if (
              typeof createErr === "object" &&
              createErr !== null &&
              (createErr as { code?: string }).code === "P2002"
            ) {
              isDuplicate = true;
              stats.duplicates++;
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
          stats.eventsSkipped++;
          const reason = normalized.skipReason ?? "unexpected_error";
          stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1;

          if (reason === "unsupported_behavior_label") {
            for (const label of normalized.observedLabels ?? []) {
              stats.unsupportedLabelsFound[label] =
                (stats.unsupportedLabelsFound[label] ?? 0) + 1;
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

          stats.driverEventsCreated++;
        } catch (err) {
          // Per-event error: log and continue — do not fail the whole sync run
          console.error(
            `[sync/samsara] Failed to create DriverEvent for event id="${rawEvent.id}":`,
            err
          );
        }
      }

      // 3c. Persist cursor after each page — safe checkpoint.
      // On crash/timeout/abort, next run re-fetches this page; dedup absorbs the overlap.
      // lastSyncAt is deliberately NOT touched here: it must only reflect a
      // fully-completed drain (see the stamp after the loop below), otherwise
      // a sync that fails partway through page N would still leave freshness
      // checks (ensureFreshSamsaraSync) seeing a recent timestamp from page
      // N-1's checkpoint and wrongly treating stale/incomplete data as fresh.
      await prisma.providerSyncState.upsert({
        where: {
          provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
        },
        update: { cursor: lastCursor },
        create: {
          provider:  PROVIDER,
          streamKey: STREAM_KEY,
          cursor:    lastCursor,
        },
      });
    }

    // Drain fully completed (hasNextPage = false) — only now is the sync
    // "fresh". Runs inside this try block so a failure here is treated the
    // same as any other mid-sync failure (falls to the catch below, synced: false).
    await prisma.providerSyncState.update({
      where: {
        provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
      },
      data: { lastSyncAt: new Date() },
    });
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

    return {
      synced: false,
      error: err instanceof Error ? err.message : "Unknown error",
      elapsedMs: Date.now() - startedAt,
      ...stats,
    };
  }

  const outcome: SamsaraSyncOutcome = {
    synced: true,
    skipped: false,
    cursor: lastCursor,
    elapsedMs: Date.now() - startedAt,
    ...stats,
  };
  console.info(JSON.stringify({ msg: "sync_complete", ...outcome }));

  return outcome;
}

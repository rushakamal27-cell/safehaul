/**
 * app/api/webhooks/samsara/route.ts
 *
 * Inbound Samsara webhook endpoint — Phase 4A: Idempotent ingestion.
 *
 * Flow:
 *   1. Read raw body bytes
 *   2. Verify signature + timestamp
 *   3. Parse payload (JSON)
 *   4. Persist WebhookLog (always — full HTTP receipt trail)
 *   5. Dedup check + persist RawProviderEvent
 *        → findUnique on (provider, externalEventId) if ID present
 *        → catch P2002 for simultaneous-retry race condition
 *        → early return 200 { duplicate: true } if already processed
 *   6. Normalize payload → NormalizedProviderEvent[]
 *   7. For each normalized event:
 *        a. Look up DriverProviderMapping by (provider, externalDriverId)
 *        b. Skip if not found or inactive (log + continue)
 *        c. Skip if isPilot = false (log + continue)
 *        d. Create DriverEvent row
 *   8. Return accepted summary
 *
 * Invariants:
 *   - ALWAYS return 200 after successful verification, even if processing fails
 *   - NEVER throw — all processing errors are caught and logged
 *   - Samsara will retry on non-2xx; do not cause retry storms on DB failures
 *
 * NOT done here (future phases):
 *   - Risk engine recalculation from DriverEvent
 *   - Push notifications / alerts
 *   - Duplicate event detection (externalEventId idempotency)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  verifySamsaraWebhook,
  WebhookVerificationError,
} from "@/lib/providers/samsara/verifyWebhook";
import {
  extractSamsaraMetadata,
  extractExternalEventId,
  type SamsaraWebhookEnvelope,
} from "@/lib/providers/samsara/types";
import { normalizeSamsaraEvent } from "@/lib/providers/samsara/normalizeEvent";
import { prisma } from "@/lib/prisma";

const PROVIDER = "samsara" as const;

export async function POST(request: NextRequest) {
  // ── Step 1: Read raw body ─────────────────────────────────────────────────
  const rawBytes = Buffer.from(await request.arrayBuffer());

  // ── Step 2: Verify signature + timestamp ─────────────────────────────────
  const signature = request.headers.get("x-samsara-signature");
  const timestamp  = request.headers.get("x-samsara-timestamp");

  try {
    verifySamsaraWebhook(rawBytes, signature, timestamp);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      if (err.code === "MISSING_SECRET") {
        console.error("[webhook/samsara] Configuration error:", err.message);
        return NextResponse.json(
          { error: "Webhook endpoint is not configured", code: err.code },
          { status: 500 }
        );
      }
      console.warn(`[webhook/samsara] Rejected (${err.code}): ${err.message}`);
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 401 }
      );
    }
    console.error("[webhook/samsara] Unexpected verification error:", err);
    return NextResponse.json({ error: "Verification failed" }, { status: 401 });
  }

  // ── Step 3: Parse payload ─────────────────────────────────────────────────
  let payload: SamsaraWebhookEnvelope;
  try {
    payload = JSON.parse(rawBytes.toString("utf-8"));
  } catch {
    console.warn("[webhook/samsara] Rejected: payload is not valid JSON");
    return NextResponse.json({ error: "Payload must be valid JSON" }, { status: 400 });
  }

  const { eventType, externalDriverId } = extractSamsaraMetadata(payload);

  // Extract the provider-side dedup key early — needed before RawProviderEvent creation.
  // null means no ID available; those events cannot be deduplicated and are always stored.
  const externalEventId = extractExternalEventId(payload);

  // ── Step 4: Persist WebhookLog (receipt layer — always written) ───────────
  // Written for every verified request, including duplicates, so the HTTP-level
  // receipt trail is always complete regardless of dedup outcome.
  let webhookLogId: string | undefined;
  try {
    const log = await prisma.webhookLog.create({
      data: {
        provider:         PROVIDER,
        eventType,
        externalDriverId,
        rawPayload:       payload as object,
        receivedAt:       new Date(),
      },
      select: { id: true },
    });
    webhookLogId = log.id;
  } catch (err) {
    // Non-fatal — processing continues even if audit log fails
    // TODO: Alert if WebhookLog writes fail persistently (dead-letter pattern)
    console.error("[webhook/samsara] Failed to write WebhookLog:", err);
  }

  // ── Step 5: Deduplication check + RawProviderEvent persistence ───────────
  // Strategy:
  //   a) If externalEventId is null → no dedup possible, always create.
  //   b) If externalEventId is present → findUnique first (optimistic path).
  //   c) If not found → create; catch P2002 for the race where two retries
  //      arrive simultaneously and both pass the findUnique check.
  //   d) If found (either via findUnique or P2002) → mark as duplicate,
  //      skip all DriverEvent creation below.
  let rawProviderEventId: string | undefined;
  let isDuplicate = false;

  try {
    if (externalEventId) {
      // Optimistic check — avoids a write on the common retry case
      const existing = await prisma.rawProviderEvent.findUnique({
        where: {
          provider_externalEventId: { provider: PROVIDER, externalEventId },
        },
        select: { id: true },
      });

      if (existing) {
        isDuplicate = true;
        rawProviderEventId = existing.id;
        console.info(
          `[webhook/samsara] Duplicate externalEventId="${externalEventId}" — skipping DriverEvent creation`
        );
      }
    }

    if (!isDuplicate) {
      try {
        const raw = await prisma.rawProviderEvent.create({
          data: {
            provider:        PROVIDER,
            webhookLogId:    webhookLogId ?? null,
            externalEventId: externalEventId ?? null,
            rawPayload:      payload as object,
            receivedAt:      new Date(),
          },
          select: { id: true },
        });
        rawProviderEventId = raw.id;
      } catch (createErr: any) {
        // P2002 = unique constraint violation — race condition between two retries
        if (createErr?.code === "P2002") {
          isDuplicate = true;
          console.info(
            `[webhook/samsara] Race-condition duplicate for externalEventId="${externalEventId}" — skipping DriverEvent creation`
          );
          // Fetch the existing row's ID so we still have referential context in logs
          const existing = await prisma.rawProviderEvent.findUnique({
            where: {
              provider_externalEventId: { provider: PROVIDER, externalEventId: externalEventId! },
            },
            select: { id: true },
          });
          rawProviderEventId = existing?.id;
        } else {
          throw createErr; // unexpected error — rethrow to outer catch
        }
      }
    }
  } catch (err) {
    console.error("[webhook/samsara] Failed to persist RawProviderEvent:", err);
  }

  // Early return for confirmed duplicates — no further processing needed
  if (isDuplicate) {
    return NextResponse.json({
      accepted:  true,
      duplicate: true,
      driverEventsCreated: 0,
    }, { status: 200 });
  }

  // ── Step 6: Normalize payload ─────────────────────────────────────────────
  // normalizeSamsaraEvent never throws — returns [] for unsupported/unparseable events.
  const normalizedEvents = normalizeSamsaraEvent(payload);

  // Counters for the summary response
  let driversMatched      = 0;
  let pilotDrivers        = 0;
  let driverEventsCreated = 0;

  // ── Step 7: Resolve mappings + create DriverEvents ────────────────────────
  for (const event of normalizedEvents) {
    try {
      // 7a. Look up DriverProviderMapping
      const mapping = await prisma.driverProviderMapping.findUnique({
        where: {
          provider_externalDriverId: {
            provider:         PROVIDER,
            externalDriverId: event.externalDriverId,
          },
        },
        select: { driverId: true, isPilot: true, isActive: true },
      });

      if (!mapping) {
        console.info(
          `[webhook/samsara] No mapping for externalDriverId="${event.externalDriverId}" — skipping`
        );
        continue;
      }

      driversMatched++;

      // 7b. Skip inactive mappings
      if (!mapping.isActive) {
        console.info(
          `[webhook/samsara] Mapping for externalDriverId="${event.externalDriverId}" is inactive — skipping`
        );
        continue;
      }

      // 7c. Pilot filter — only create DriverEvents for pilot drivers
      if (!mapping.isPilot) {
        console.info(
          `[webhook/samsara] Driver driverId="${mapping.driverId}" is not a pilot — skipping`
        );
        continue;
      }

      pilotDrivers++;

      // 7d. Guard: RawProviderEvent must exist to maintain referential integrity
      if (!rawProviderEventId) {
        console.error(
          "[webhook/samsara] Cannot create DriverEvent: RawProviderEvent was not persisted"
        );
        continue;
      }

      // 7e. Create normalized DriverEvent
      await prisma.driverEvent.create({
        data: {
          driverId:           mapping.driverId,
          rawProviderEventId,
          provider:           PROVIDER,
          externalDriverId:   event.externalDriverId,
          externalVehicleId:  event.externalVehicleId ?? null,
          type:               event.type,
          severity:           event.severity,
          timestamp:          new Date(event.timestamp),
          lat:                event.lat ?? null,
          lng:                event.lng ?? null,
        },
      });

      driverEventsCreated++;
    } catch (err) {
      // Per-event error: log and continue — do not fail the whole webhook
      console.error(
        `[webhook/samsara] Failed to process event for externalDriverId="${event.externalDriverId}":`,
        err
      );
    }
  }

  // ── Step 8: Return accepted summary ──────────────────────────────────────
  return NextResponse.json({
    accepted:            true,
    duplicate:           false,
    eventsReceived:      normalizedEvents.length,
    driversMatched,
    pilotDrivers,
    driverEventsCreated,
  }, { status: 200 });
}

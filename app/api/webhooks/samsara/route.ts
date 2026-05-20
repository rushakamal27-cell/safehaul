/**
 * app/api/webhooks/samsara/route.ts
 *
 * Inbound Samsara webhook endpoint — Phase 3: Event normalization.
 *
 * Flow:
 *   1. Read raw body bytes
 *   2. Verify signature + timestamp
 *   3. Parse payload (JSON)
 *   4. Persist WebhookLog (receipt audit trail)
 *   5. Persist RawProviderEvent (pre-normalization audit trail)
 *   6. Normalize payload → NormalizedProviderEvent[]
 *   7. For each normalized event:
 *        a. Look up DriverProviderMapping by (provider, externalDriverId)
 *        b. Skip if not found (log + continue)
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

  // ── Step 4: Persist WebhookLog (receipt layer) ────────────────────────────
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

  // ── Step 5: Persist RawProviderEvent ─────────────────────────────────────
  // Stores the parsed payload before normalization — enables replay if normalization logic changes.
  let rawProviderEventId: string | undefined;
  try {
    const raw = await prisma.rawProviderEvent.create({
      data: {
        provider:        PROVIDER,
        webhookLogId:    webhookLogId ?? null,
        // TODO: Extract provider's own event ID here for deduplication (Phase 4).
        //       Field path TBD — may be payload.eventId or payload.data?.id.
        externalEventId: null,
        rawPayload:      payload as object,
        receivedAt:      new Date(),
      },
      select: { id: true },
    });
    rawProviderEventId = raw.id;
  } catch (err) {
    console.error("[webhook/samsara] Failed to write RawProviderEvent:", err);
  }

  // ── Step 6: Normalize payload ─────────────────────────────────────────────
  // normalizeSamsaraEvent never throws — returns [] for unsupported/unparseable events.
  const normalizedEvents = normalizeSamsaraEvent(payload);

  // Counters for the summary response
  let driversMatched    = 0;
  let pilotDrivers      = 0;
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

      // 7b. Skip if inactive mapping
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
    eventsReceived:      normalizedEvents.length,
    driversMatched,
    pilotDrivers,
    driverEventsCreated,
  }, { status: 200 });
}

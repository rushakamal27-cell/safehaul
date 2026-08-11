/**
 * scripts/backfillCrashEvent.ts
 *
 * One-off, conservative backfill for the 2026-08-07 Samsara Crash event
 * (pilot driver Rushana, externalEventId
 * "5445dc28-0e86-5987-8953-e0d4791b8cde") that was correctly fetched and
 * stored as a RawProviderEvent but never became a DriverEvent, because
 * SAMSARA_TYPE_MAP had no entry for the "Crash" behavior label at the time
 * (fixed in lib/providers/samsara/normalizeEvent.ts, 2026-08-xx — see that
 * file's comment on the Crash/crash entries for the full incident writeup).
 *
 * Deliberately narrow: targets ONLY this one specific externalEventId, not
 * a general "reprocess every unsupported-label event" tool — a full scan
 * of RawProviderEvent history (done as part of the same investigation)
 * confirmed this is the only orphaned Crash event that has ever been
 * stored. If a second one is ever found, add its externalEventId to
 * TARGET_EXTERNAL_EVENT_IDS below rather than broadening this script's
 * scope.
 *
 * Safe by construction:
 *   - Reuses the REAL production normalizer (normalizeSafetyStreamEvent)
 *     against the REAL stored raw payload — never reimplements or guesses
 *     at the mapping logic, so its output is guaranteed identical to what
 *     the live sync would have produced had SAMSARA_TYPE_MAP supported
 *     "Crash" at ingestion time.
 *   - Idempotent: checks whether a DriverEvent already references this
 *     RawProviderEvent before creating one (mirrors the dedup guarantee
 *     RawProviderEvent.@@unique([provider, externalEventId]) already gives
 *     the rest of the pipeline) — running this script twice is a no-op the
 *     second time.
 *   - Dry-run by default. Requires an explicit --apply flag to write
 *     anything. Dry-run prints exactly what the DriverEvent.create() call
 *     would look like.
 *   - Never touches ProviderSyncState / the sync cursor, and never calls
 *     the Samsara API — this only reads an already-stored RawProviderEvent
 *     row and (optionally) creates one DriverEvent row from it.
 *
 * Usage:
 *   npx tsx scripts/backfillCrashEvent.ts            # dry run (default)
 *   npx tsx scripts/backfillCrashEvent.ts --apply     # actually create the DriverEvent
 */

import { prisma } from "@/lib/prisma";
import { normalizeSafetyStreamEvent } from "@/lib/providers/samsara/normalizeStreamEvent";
import type { SamsaraSafetyStreamEvent } from "@/lib/providers/samsara/types";

const PROVIDER = "samsara" as const;

const TARGET_EXTERNAL_EVENT_IDS = ["5445dc28-0e86-5987-8953-e0d4791b8cde"] as const;

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`[backfillCrashEvent] Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
  console.log(`[backfillCrashEvent] Target externalEventId(s): ${TARGET_EXTERNAL_EVENT_IDS.join(", ")}\n`);

  let wouldCreate = 0;
  let created = 0;
  let skippedAlreadyBackfilled = 0;
  let skippedNotFound = 0;
  let skippedNormalizationFailed = 0;
  let skippedNoMapping = 0;
  let skippedMappingInactive = 0;

  for (const externalEventId of TARGET_EXTERNAL_EVENT_IDS) {
    console.log(`--- ${externalEventId} ---`);

    const raw = await prisma.rawProviderEvent.findUnique({
      where: { provider_externalEventId: { provider: PROVIDER, externalEventId } },
      include: { driverEvents: { select: { id: true, type: true, driverId: true, timestamp: true } } },
    });

    if (!raw) {
      console.log("  SKIP: no RawProviderEvent found with this externalEventId. Nothing to backfill.");
      skippedNotFound++;
      continue;
    }

    // Idempotency guard — if a DriverEvent already references this raw
    // row (e.g. this script already ran with --apply, or the pipeline
    // somehow created one through another path), do nothing further.
    if (raw.driverEvents.length > 0) {
      console.log(`  SKIP: already backfilled — DriverEvent(s) already exist:`, JSON.stringify(raw.driverEvents));
      skippedAlreadyBackfilled++;
      continue;
    }

    // Reuse the real normalizer against the real stored payload — this is
    // the exact function the live stream sync calls on every page.
    const streamEvent = raw.rawPayload as unknown as SamsaraSafetyStreamEvent;
    const result = normalizeSafetyStreamEvent(streamEvent);

    if (!result.event) {
      console.log(`  SKIP: normalization still fails (skipReason="${result.skipReason}"). Nothing to backfill — investigate before proceeding.`);
      skippedNormalizationFailed++;
      continue;
    }
    const normalized = result.event;

    // Mirror processPage's mapping resolution exactly (lib/providers/samsara/syncSafetyEvents.ts).
    const mapping = await prisma.driverProviderMapping.findUnique({
      where: { provider_externalDriverId: { provider: PROVIDER, externalDriverId: normalized.externalDriverId } },
      select: { driverId: true, isPilot: true, isActive: true },
    });

    if (!mapping) {
      console.log(`  SKIP: no DriverProviderMapping for externalDriverId="${normalized.externalDriverId}".`);
      skippedNoMapping++;
      continue;
    }
    if (!mapping.isActive || !mapping.isPilot) {
      console.log(`  SKIP: mapping for externalDriverId="${normalized.externalDriverId}" is not an active pilot (isActive=${mapping.isActive}, isPilot=${mapping.isPilot}).`);
      skippedMappingInactive++;
      continue;
    }

    const driverEventData = {
      driverId: mapping.driverId,
      rawProviderEventId: raw.id,
      provider: PROVIDER,
      externalDriverId: normalized.externalDriverId,
      externalVehicleId: normalized.externalVehicleId ?? null,
      type: normalized.type,
      severity: normalized.severity,
      timestamp: new Date(normalized.timestamp),
      lat: normalized.lat ?? null,
      lng: normalized.lng ?? null,
    };

    console.log("  Would create DriverEvent:", JSON.stringify(driverEventData, null, 2));
    wouldCreate++;

    if (APPLY) {
      const createdRow = await prisma.driverEvent.create({ data: driverEventData });
      console.log(`  CREATED: DriverEvent id=${createdRow.id}`);
      created++;
    }
  }

  console.log("\n[backfillCrashEvent] Summary:");
  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    wouldCreate,
    created,
    skippedAlreadyBackfilled,
    skippedNotFound,
    skippedNormalizationFailed,
    skippedNoMapping,
    skippedMappingInactive,
  }, null, 2));

  if (!APPLY && wouldCreate > 0) {
    console.log("\nDry run only — no rows were written. Re-run with --apply to create the DriverEvent(s) above.");
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[backfillCrashEvent] Fatal error:", err);
  await prisma.$disconnect();
  process.exit(1);
});

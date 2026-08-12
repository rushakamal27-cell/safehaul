/**
 * scripts/captureDriverObservation.ts
 *
 * Phase 6B.2 manual test entry point for the DriverObservation collector
 * (lib/driverContext/captureObservation.ts). No cron, no scheduler, no
 * Safety Event hook, no public route — a one-off CLI script, matching the
 * pattern already established by scripts/backfillCrashEvent.ts.
 *
 * Dry-run by default: builds and prints the snapshot that WOULD be
 * persisted (via buildDriverObservationSnapshot, which does no writes)
 * without touching the database. Requires an explicit --apply flag to
 * actually call captureDriverObservation() and create a row.
 *
 * Usage:
 *   npx tsx scripts/captureDriverObservation.ts --driverId=<id>              # dry run (default)
 *   npx tsx scripts/captureDriverObservation.ts --driverId=<id> --apply      # actually create the row
 *   npx tsx scripts/captureDriverObservation.ts --driverId=<id> --trigger=safety_event --driverEventId=<id> [--apply]
 */

import { config as loadEnv } from "dotenv";
import { prisma } from "@/lib/prisma";
import {
  buildDriverObservationSnapshot,
  captureDriverObservation,
  type DriverObservationTriggerType,
} from "@/lib/driverContext/captureObservation";

// tsx only auto-loads .env, not .env.local — but SAMSARA_API_TOKEN and
// OPENWEATHER_API_KEY live in .env.local (Next.js loads both at runtime;
// see "Environments: .env.local, .env" in `next build`'s own output). Safe
// to call before main(): none of the imported modules read these env vars
// at import time, only lazily inside the async functions main() calls.
loadEnv({ path: ".env.local" });
loadEnv();

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

const APPLY = process.argv.includes("--apply");
const driverId = readFlag("driverId");
const trigger = (readFlag("trigger") ?? "interval") as DriverObservationTriggerType;
const driverEventId = readFlag("driverEventId");

async function main() {
  if (!driverId) {
    console.error("[captureDriverObservation] Missing required --driverId=<id>");
    process.exit(1);
  }
  if (trigger !== "interval" && trigger !== "safety_event") {
    console.error(`[captureDriverObservation] Invalid --trigger="${trigger}" (must be "interval" or "safety_event")`);
    process.exit(1);
  }

  console.log(`[captureDriverObservation] Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
  console.log(`[captureDriverObservation] driverId=${driverId} trigger=${trigger} driverEventId=${driverEventId ?? "(none)"}\n`);

  const params = { driverId, triggerType: trigger, driverEventId };

  if (!APPLY) {
    const snapshot = await buildDriverObservationSnapshot(params);
    console.log("Would create DriverObservation:", JSON.stringify(snapshot, null, 2));
    console.log("\nDry run only — no row was written. Re-run with --apply to create it.");
  } else {
    const created = await captureDriverObservation(params);
    console.log("CREATED DriverObservation:", JSON.stringify(created, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[captureDriverObservation] Fatal error:", err);
  await prisma.$disconnect();
  process.exit(1);
});

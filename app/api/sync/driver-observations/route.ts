/**
 * app/api/sync/driver-observations/route.ts
 *
 * Phase 6B.3 — manual ops entry point for one baseline (triggerType:
 * "interval") DriverObservation capture cycle across active pilot drivers.
 * Auth pattern copied verbatim from app/api/sync/samsara-safety-events/route.ts
 * (CRON_SECRET bearer token) — same reasoning applies: this is kept for
 * manual testing and any future ops/cron use, but NO cron entry exists yet
 * (vercel.json is untouched by this phase). Runs only when called manually
 * with a valid CRON_SECRET.
 *
 * Core orchestration lives in lib/driverContext/baselineObservationSync.ts,
 * not here — this route is auth + a thin HTTP wrapper, matching this
 * codebase's route → service/helper → DB convention.
 */

import { NextRequest, NextResponse } from "next/server";
import { runBaselineObservationSync } from "@/lib/driverContext/baselineObservationSync";
import { verifyCronSecret } from "@/lib/cronAuth";

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runBaselineObservationSync();
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    // Server-side only — never leak provider payloads/secrets/stack to the
    // caller, matching /api/risk's error envelope convention.
    console.error("[sync/driver-observations] Unhandled error:", error);
    return NextResponse.json(
      { ok: false, error: "Unable to run baseline observation sync right now." },
      { status: 500 }
    );
  }
}

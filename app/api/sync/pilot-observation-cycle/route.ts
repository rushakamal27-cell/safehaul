/**
 * app/api/sync/pilot-observation-cycle/route.ts
 *
 * Phase 6B.6 — combined hybrid pilot observation cycle: Safety Events sync
 * (with its existing enrichment) followed by baseline interval capture, as
 * ONE ops entry point intended to eventually become the single periodic
 * scheduler job for pilot data collection (replacing the need to schedule
 * /api/sync/samsara-safety-events and /api/sync/driver-observations
 * separately). CRON_SECRET bearer auth, same pattern as those two routes.
 *
 * IMPORTANT: as of this commit, NO cron entry has been added for this route
 * (vercel.json is untouched) — see the Phase 6B.6 report for why: this
 * project's connected Vercel account has no SafeHaul/roadtalk-app project
 * registered, so the actual deployment's plan tier could not be verified,
 * and this repo's own documentation (project_context.md, CLAUDE.md) records
 * a prior decision that the Vercel Hobby plan cannot run sub-daily cron
 * reliably. This route is manual/ops-only until that is confirmed
 * otherwise. The three individual routes
 * (/api/sync/samsara-safety-events, /api/sync/driver-observations) remain
 * available and unmodified for standalone operational/debugging use.
 */

import { NextRequest, NextResponse } from "next/server";
import { runPilotObservationCycle } from "@/lib/driverContext/pilotObservationCycle";
import { verifyCronSecret } from "@/lib/cronAuth";

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runPilotObservationCycle();

  switch (result.cycleStatus) {
    case "cycle_in_progress":
      // Another invocation already owns the job lock — not a failure, just
      // a no-op this call. 409 Conflict mirrors the Safety Events ops
      // route's own precedent for "the resource is currently locked."
      return NextResponse.json(result, { status: 409 });
    case "lock_error":
      return NextResponse.json(result, { status: 500 });
    case "completed":
      // Always 200 here — a partial failure inside safetyEvents or
      // baseline is represented in the body's own status fields, not
      // collapsed into an HTTP error for the whole cycle (Requirement 7:
      // "Safety Events failed but baseline succeeded should NOT be
      // represented as though nothing happened").
      return NextResponse.json(result, { status: 200 });
  }
}

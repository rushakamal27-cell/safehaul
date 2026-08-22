/**
 * app/api/sync/daily-finalization/route.ts
 *
 * Part 3/Part 4/Part 7 — autonomous daily Audit history finalization.
 * Intended schedule: once daily, shortly after UTC midnight (~00:10 UTC),
 * so the "previous UTC day" runDailyFinalization computes (see
 * lib/riskSampling/dayBounds.ts::utcPreviousDayBounds) has fully ended.
 * CRON_SECRET bearer auth, same pattern as the other sync routes. Own
 * (provider, streamKey) lock row — "safehaul"/"daily-finalization" —
 * independent of the hourly sampling lock and the Phase 6B/6C locks.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cronAuth";
import { withProviderSyncLock } from "@/lib/providerSyncLock";
import { runDailyFinalization } from "@/lib/riskSampling/dailyFinalization";

const LOCK_KEY = { provider: "safehaul", streamKey: "daily-finalization" } as const;

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await withProviderSyncLock({
    key: LOCK_KEY,
    run: () => runDailyFinalization(),
  });

  switch (outcome.status) {
    case "sync_in_progress":
      return NextResponse.json({ status: "cycle_in_progress" }, { status: 409 });
    case "lock_acquire_failed":
      return NextResponse.json({ status: "lock_error", error: "Failed to acquire daily-finalization lock" }, { status: 500 });
    case "threw":
      return NextResponse.json({ status: "failed", error: outcome.error }, { status: 500 });
    case "acquired":
      return NextResponse.json({ status: "completed", ...outcome.result }, { status: 200 });
  }
}

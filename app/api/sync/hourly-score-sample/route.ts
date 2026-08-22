/**
 * app/api/sync/hourly-score-sample/route.ts
 *
 * Part 2/Part 7 — autonomous hourly derived Safety Score collection.
 * CRON_SECRET bearer auth, same pattern as
 * /api/sync/pilot-observation-cycle. Wrapped in the same provider-neutral
 * DB-backed job lock (lib/providerSyncLock.ts) under its OWN
 * (provider, streamKey) row — "safehaul"/"hourly-score-sample" — so this
 * job can never overlap with itself, and never contends with the Samsara
 * Safety Events lock or the pilot-observation-cycle job lock (three
 * independent rows, same non-blocking single-attempt claim mechanism, so no
 * deadlock risk — see pilotObservationCycle.ts's header for why that
 * property holds).
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cronAuth";
import { withProviderSyncLock } from "@/lib/providerSyncLock";
import { runHourlyScoreSampling } from "@/lib/riskSampling/hourlyScoreSampling";

const LOCK_KEY = { provider: "safehaul", streamKey: "hourly-score-sample" } as const;

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await withProviderSyncLock({
    key: LOCK_KEY,
    run: () => runHourlyScoreSampling(),
  });

  switch (outcome.status) {
    case "sync_in_progress":
      return NextResponse.json({ status: "cycle_in_progress" }, { status: 409 });
    case "lock_acquire_failed":
      return NextResponse.json({ status: "lock_error", error: "Failed to acquire hourly-score-sample lock" }, { status: 500 });
    case "threw":
      return NextResponse.json({ status: "failed", error: outcome.error }, { status: 500 });
    case "acquired":
      return NextResponse.json({ status: "completed", ...outcome.result }, { status: 200 });
  }
}

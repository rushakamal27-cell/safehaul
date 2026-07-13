/**
 * app/api/sync/samsara-safety-events/route.ts
 *
 * External entry point for the Samsara Safety Events Stream sync. The core
 * operation lives in lib/providers/samsara/syncSafetyEvents.ts so it can also
 * be invoked in-process (no HTTP hop) from the on-demand path in /api/risk —
 * see lib/providers/samsara/onDemandSync.ts.
 *
 * The 5-minute Vercel Cron entry has been removed (the project is on the
 * Hobby plan, which cannot run it reliably). This route is kept for manual
 * testing and any future ops/cron use: GET with
 * Authorization: Bearer $CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { runSamsaraSafetyEventsSync } from "@/lib/providers/samsara/syncSafetyEvents";

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
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await runSamsaraSafetyEventsSync();

  return NextResponse.json(outcome, { status: outcome.synced ? 200 : 500 });
}

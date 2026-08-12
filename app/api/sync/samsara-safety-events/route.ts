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
 *
 * Phase 6B.5: this route now goes through the SAME DB-backed lock
 * (lib/providers/samsara/syncLock.ts::withSamsaraSyncLock) the on-demand
 * path in /api/risk already used — previously it called
 * runSamsaraSafetyEventsSync() directly, meaning a manual/ops-triggered
 * sync and an on-demand sync could race the cursor if they landed at
 * nearly the same instant. No timeoutMs is passed here (unlike the
 * on-demand path's tight 6s bound) — this route is its own separate
 * function invocation with no shared request budget to protect, and should
 * be allowed to run a full catch-up drain across many pages if needed. See
 * syncLock.ts's file header for the full reasoning.
 */

import { NextRequest, NextResponse } from "next/server";
import { withSamsaraSyncLock } from "@/lib/providers/samsara/syncLock";

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

  const lockResult = await withSamsaraSyncLock();

  switch (lockResult.status) {
    case "sync_in_progress":
      // Another caller (on-demand or a separate manual/scheduled
      // invocation) already holds the lock — this is not a failure, just
      // a no-op this call. 409 Conflict is the closest accurate HTTP
      // status for "the resource is currently locked."
      return NextResponse.json(
        { synced: false, skipped: true, reason: "sync_in_progress" },
        { status: 409 }
      );
    case "lock_acquire_failed":
      return NextResponse.json(
        { synced: false, error: "Failed to acquire sync lock" },
        { status: 500 }
      );
    case "sync_threw":
      return NextResponse.json({ synced: false, error: lockResult.error }, { status: 500 });
    case "acquired":
      return NextResponse.json(lockResult.outcome, { status: lockResult.outcome.synced ? 200 : 500 });
  }
}

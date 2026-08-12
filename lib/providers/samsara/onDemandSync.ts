/**
 * lib/providers/samsara/onDemandSync.ts
 *
 * On-demand freshness check for pilot drivers, called from /api/risk before
 * scoring a Heads-Up request. Replaces the removed 5-minute Vercel Cron (the
 * project's Hobby plan cannot run it reliably): instead, the first request
 * that finds Samsara data stale triggers a refresh inline.
 *
 * Phase 6B.5: the actual DB-backed lock this module relies on now lives in
 * lib/providers/samsara/syncLock.ts (withSamsaraSyncLock), shared with
 * app/api/sync/samsara-safety-events/route.ts so an on-demand sync and a
 * manual/future-scheduled sync can never run concurrently. This module's
 * own job narrows to exactly one concern: deciding WHETHER a refresh is
 * worth attempting at all (the 5-minute freshness gate below) and mapping
 * the shared lock's outcome onto this module's own OnDemandSyncStatus
 * vocabulary. See syncLock.ts's file header for why lock acquisition,
 * the freshness decision, and the sync timeout are kept as three
 * independent concerns rather than being bundled together.
 *
 * Statuses:
 *   "fresh"            — lastSyncAt was readable and under 5 minutes old. No
 *                         lock attempted, no Samsara call, no writes.
 *   "refreshed"         — this request won the lock and a full sync drain
 *                         completed successfully (lastSyncAt was updated).
 *   "refresh_failed"    — this request won the lock but the sync errored,
 *                         was aborted by the timeout, or the lock claim
 *                         itself failed (e.g. a DB error) — stored
 *                         DriverEvents are used as a fallback either way.
 *   "sync_in_progress"  — this request needed a refresh but lost the lock
 *                         race to a concurrent request that is already
 *                         syncing (or holds a not-yet-stale lock) — this now
 *                         includes losing the race to a manual/scheduled ops
 *                         sync, not just another on-demand request.
 *   There is deliberately no separate "no sync state" status: a missing or
 *   unreadable ProviderSyncState row is treated as "not fresh" and funnels
 *   into the same refresh attempt as a stale row, resolving to one of the
 *   four statuses above — never an ambiguous combination.
 */

import { prisma } from "@/lib/prisma";
import { PROVIDER, STREAM_KEY, type SamsaraSyncOutcome } from "./syncSafetyEvents";
import {
  withSamsaraSyncLock,
  type ProviderSyncStateClient,
} from "./syncLock";

// Re-exported so existing imports of ProviderSyncStateClient from this
// module (tests, callers written before Phase 6B.5) keep working unchanged
// — the type itself now lives in syncLock.ts, the module that actually owns
// the lock mechanics.
export type { ProviderSyncStateClient };

const FRESHNESS_MS = 5 * 60 * 1000; // matches the product spec's staleness threshold — see docs/data-freshness.md for how this compares to the other freshness thresholds in the codebase
const SYNC_TIMEOUT_MS = 6_000;

export type OnDemandSyncStatus =
  | "fresh"
  | "refreshed"
  | "refresh_failed"
  | "sync_in_progress";

export interface OnDemandSyncDecision {
  status: OnDemandSyncStatus;
  previousLastSyncAt: Date | null;
  elapsedMs: number;
}

export interface OnDemandSyncDeps {
  /** Injectable for tests; defaults to the real Prisma delegate. */
  client?: ProviderSyncStateClient;
  /** Injectable for tests; defaults to the real sync operation. */
  runSync?: (signal?: AbortSignal) => Promise<SamsaraSyncOutcome>;
  /** Injectable for tests; defaults to SYNC_TIMEOUT_MS (6s) — avoids real 6s sleeps in timeout tests. */
  timeoutMs?: number;
}

/**
 * Ensures Samsara Safety Events data is fresh (<5 min old) for pilot drivers,
 * triggering an in-process sync if it is stale, missing, or unreadable. Never
 * throws — callers should proceed with whatever DriverEvents already exist
 * regardless of the returned status.
 */
export async function ensureFreshSamsaraSync(
  deps: OnDemandSyncDeps = {}
): Promise<OnDemandSyncDecision> {
  const client = deps.client ?? (prisma.providerSyncState as unknown as ProviderSyncStateClient);
  const timeoutMs = deps.timeoutMs ?? SYNC_TIMEOUT_MS;

  const decisionStart = Date.now();
  const elapsed = () => Date.now() - decisionStart;

  let previousLastSyncAt: Date | null = null;
  let readFailed = false;

  try {
    const state = await client.findUnique({
      where: { provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY } },
      select: { lastSyncAt: true },
    });
    previousLastSyncAt = state?.lastSyncAt ?? null;
  } catch (err) {
    // Can't determine current freshness. "No readable sync state" is an
    // internal reason, not a status of its own — fall through and attempt
    // a refresh so the final status still resolves deterministically.
    console.error("[on-demand-sync] Failed to read sync state:", err);
    readFailed = true;
  }

  const isFresh =
    !readFailed &&
    previousLastSyncAt !== null &&
    Date.now() - previousLastSyncAt.getTime() < FRESHNESS_MS;

  if (isFresh) {
    return { status: "fresh", previousLastSyncAt, elapsedMs: elapsed() };
  }

  // Missing, stale, or unreadable sync state — all funnel into "attempt a
  // refresh" via the shared lock. Passes the tight 6s timeoutMs explicitly —
  // this path is embedded inside /api/risk's own request budget, unlike the
  // manual ops route (see syncLock.ts's file header).
  const lockResult = await withSamsaraSyncLock({ client, runSync: deps.runSync, timeoutMs });

  switch (lockResult.status) {
    case "sync_in_progress":
      return { status: "sync_in_progress", previousLastSyncAt, elapsedMs: elapsed() };
    case "lock_acquire_failed":
    case "sync_threw":
      return { status: "refresh_failed", previousLastSyncAt, elapsedMs: elapsed() };
    case "acquired":
      return {
        status: lockResult.outcome.synced ? "refreshed" : "refresh_failed",
        previousLastSyncAt,
        elapsedMs: elapsed(),
      };
  }
}

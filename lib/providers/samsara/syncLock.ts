/**
 * lib/providers/samsara/syncLock.ts
 *
 * Phase 6B.5 — the DB-backed Samsara Safety Events sync lock, shared by
 * every caller of runSamsaraSafetyEventsSync (the on-demand path embedded
 * in /api/risk, and the manual/scheduled ops route), so an on-demand sync
 * and a manually-triggered (or scheduled) sync can never run concurrently
 * and race the cursor.
 *
 * Phase 6B.6: the underlying lock mechanism now lives in the provider-
 * neutral lib/providerSyncLock.ts (withProviderSyncLock), generalized so
 * the new pilot-observation-cycle job lock can reuse the exact same
 * mechanism without duplicating it. This module is now a thin wrapper
 * fixed to the (samsara, safety-events) key — its own public API
 * (withSamsaraSyncLock, SyncLockOutcome, WithSamsaraSyncLockDeps,
 * ProviderSyncStateClient) is UNCHANGED from Phase 6B.5, so nothing that
 * already depends on it (onDemandSync.ts, the Safety Events ops route,
 * every existing test) needed to change.
 *
 * See lib/providerSyncLock.ts for the full concurrency-guard/staleness/
 * timeout rationale (identical to Phase 6B.5's design, just relocated).
 */

import {
  withProviderSyncLock,
  type ProviderSyncStateClient,
} from "@/lib/providerSyncLock";
import {
  runSamsaraSafetyEventsSync,
  PROVIDER,
  STREAM_KEY,
  type SamsaraSyncOutcome,
} from "./syncSafetyEvents";

// Re-exported so existing imports of ProviderSyncStateClient from this
// module keep working unchanged.
export type { ProviderSyncStateClient };

export type SyncLockOutcome =
  | { status: "acquired"; outcome: SamsaraSyncOutcome }
  | { status: "sync_in_progress" }
  | { status: "lock_acquire_failed" }
  | { status: "sync_threw"; error: string };

export interface WithSamsaraSyncLockDeps {
  /** Injectable for tests; defaults to the real Prisma delegate. */
  client?: ProviderSyncStateClient;
  /** Injectable for tests; defaults to the real sync operation. */
  runSync?: (signal?: AbortSignal) => Promise<SamsaraSyncOutcome>;
  /**
   * Bounds the sync attempt via AbortController when set. Left undefined by
   * default — no forced cutoff — since an arbitrary timeout is not a safe
   * default for every caller (see lib/providerSyncLock.ts's file header).
   * Callers that need one (on-demand, embedded in a tight request budget)
   * must opt in explicitly.
   */
  timeoutMs?: number;
}

/**
 * Attempts to claim the shared Safety Events sync lock and, if successful,
 * runs `runSync` under it. Never throws — see lib/providerSyncLock.ts's
 * withProviderSyncLock, which this delegates to entirely.
 */
export async function withSamsaraSyncLock(
  deps: WithSamsaraSyncLockDeps = {}
): Promise<SyncLockOutcome> {
  const result = await withProviderSyncLock<SamsaraSyncOutcome>({
    key: { provider: PROVIDER, streamKey: STREAM_KEY },
    client: deps.client,
    run: deps.runSync ?? runSamsaraSafetyEventsSync,
    timeoutMs: deps.timeoutMs,
  });

  switch (result.status) {
    case "acquired":
      return { status: "acquired", outcome: result.result };
    case "sync_in_progress":
      return { status: "sync_in_progress" };
    case "lock_acquire_failed":
      return { status: "lock_acquire_failed" };
    case "threw":
      return { status: "sync_threw", error: result.error };
  }
}

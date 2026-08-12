/**
 * lib/providers/samsara/syncLock.ts
 *
 * Phase 6B.5 — the DB-backed Safety Events sync lock, extracted out of
 * onDemandSync.ts so it can be shared by every caller of
 * runSamsaraSafetyEventsSync, not just the on-demand path embedded in
 * /api/risk. Before this phase, app/api/sync/samsara-safety-events/route.ts
 * called runSamsaraSafetyEventsSync() directly, bypassing this lock
 * entirely — meaning an on-demand sync and a manually-triggered (or, once
 * cron exists, scheduled) sync could race the cursor. Both paths now go
 * through withSamsaraSyncLock below.
 *
 * Concurrency guard (unchanged from the original onDemandSync.ts design):
 *   Multiple callers can arrive at the same instant across separate
 *   serverless instances, so an in-memory flag would not prevent duplicate
 *   syncs. The lock lives entirely in ProviderSyncState.syncLockedAt and is
 *   claimed in two atomic steps that together cover both cold start (no row
 *   yet) and warm state (row exists, lock null or stale):
 *
 *     1. INSERT a row with syncLockedAt = now. If no row exists yet, this
 *        single INSERT both creates the row AND claims the lock — Postgres
 *        guarantees only one concurrent INSERT can win a unique key, so
 *        exactly one cold-start racer succeeds; the rest get a unique
 *        constraint violation (P2002), which is caught and treated as
 *        "someone else got here first" rather than an error. This mirrors
 *        the create+catch(P2002) pattern already used for RawProviderEvent
 *        in syncSafetyEvents.ts — we do not rely on upsert()'s internal
 *        atomicity, which is not a guarantee this codebase trusts elsewhere.
 *     2. If the row already existed (INSERT lost the race, or a previous
 *        run created it), fall back to a single atomic UPDATE:
 *          UPDATE ... WHERE syncLockedAt IS NULL OR syncLockedAt < staleThreshold
 *        Postgres row-locks the matching row for the duration of the UPDATE,
 *        so concurrent claims serialize and only one caller sees rowCount = 1.
 *
 *   Losers of either step never call runSync at all — they resolve
 *   immediately with status "sync_in_progress". RawProviderEvent's unique
 *   constraint remains a second line of defense against duplicate event
 *   rows regardless of any lock behavior.
 *
 * Lock staleness:
 *   Set well above any caller's expected sync duration (20s) so a lock is
 *   never reclaimed out from under a sync that is still legitimately
 *   running — it only protects against a lock left behind by a crashed/
 *   killed instance.
 *
 * Timeout is deliberately NOT part of this module's own defaults — see
 * withSamsaraSyncLock's `timeoutMs` param. Lock acquisition and the
 * freshness DECISION of whether to bother syncing at all are two separate
 * concerns (see onDemandSync.ts, which layers its own 5-minute freshness
 * gate on top of this lock); how long a caller is willing to let the
 * underlying drain run is a THIRD, independent concern, and differs
 * legitimately per caller:
 *   - the on-demand path (onDemandSync.ts) is embedded inside /api/risk's
 *     tight request budget (Vercel Hobby's ~10s function limit), so it
 *     passes a tight 6s timeoutMs.
 *   - a manual/future-scheduled ops call (app/api/sync/samsara-safety-events)
 *     is its own separate function invocation with no such shared budget,
 *     and may legitimately need to run a full catch-up drain across many
 *     pages — forcing the same 6s cutoff on it would silently truncate a
 *     catch-up sync it should be allowed to complete. It passes no
 *     timeoutMs at all (undefined), so no AbortController is created and the
 *     drain runs to completion, bounded only by the platform's own function
 *     execution limit.
 */

import { prisma } from "@/lib/prisma";
import {
  runSamsaraSafetyEventsSync,
  PROVIDER,
  STREAM_KEY,
  type SamsaraSyncOutcome,
} from "./syncSafetyEvents";

const LOCK_STALE_MS = 20_000;

/** Minimal slice of the Prisma ProviderSyncState delegate this module needs — narrow enough to fake in tests. */
export interface ProviderSyncStateClient {
  findUnique(args: {
    where: { provider_streamKey: { provider: string; streamKey: string } };
    select: { lastSyncAt: true };
  }): Promise<{ lastSyncAt: Date | null } | null>;
  create(args: {
    data: { provider: string; streamKey: string; syncLockedAt: Date };
  }): Promise<unknown>;
  updateMany(args: {
    where: {
      provider: string;
      streamKey: string;
      OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: Date } }];
    };
    data: { syncLockedAt: Date };
  }): Promise<{ count: number }>;
  update(args: {
    where: { provider_streamKey: { provider: string; streamKey: string } };
    data: { syncLockedAt: Date | null };
  }): Promise<unknown>;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

async function tryAcquireLock(
  client: ProviderSyncStateClient,
  now: Date
): Promise<boolean> {
  // Step 1: race-safe row creation + lock claim in one atomic INSERT.
  try {
    await client.create({
      data: { provider: PROVIDER, streamKey: STREAM_KEY, syncLockedAt: now },
    });
    return true;
  } catch (err: unknown) {
    if (!isUniqueConstraintViolation(err)) throw err;
    // Row already existed — fall through to claim it via atomic UPDATE.
  }

  // Step 2: row exists (created just now by a racer, or from a prior run).
  const staleBefore = new Date(now.getTime() - LOCK_STALE_MS);
  const claim = await client.updateMany({
    where: {
      provider: PROVIDER,
      streamKey: STREAM_KEY,
      OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: staleBefore } }],
    },
    data: { syncLockedAt: now },
  });

  return claim.count === 1;
}

async function releaseLock(client: ProviderSyncStateClient): Promise<void> {
  await client
    .update({
      where: { provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY } },
      data: { syncLockedAt: null },
    })
    .catch((err) => console.error("[sync-lock] Failed to release lock:", err));
}

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
   * default for every caller (see file header). Callers that need one
   * (on-demand, embedded in a tight request budget) must opt in explicitly.
   */
  timeoutMs?: number;
}

/**
 * Attempts to claim the shared Safety Events sync lock and, if successful,
 * runs `runSync` under it — releasing the lock in `finally` regardless of
 * outcome. Never throws: a lock-acquisition failure or a thrown sync error
 * both resolve to a status rather than propagating, so every caller (the
 * freshness-gated on-demand path, the manual/future-scheduled ops route)
 * gets a uniform, exhaustive result to switch on.
 */
export async function withSamsaraSyncLock(
  deps: WithSamsaraSyncLockDeps = {}
): Promise<SyncLockOutcome> {
  const client = deps.client ?? (prisma.providerSyncState as unknown as ProviderSyncStateClient);
  const runSync = deps.runSync ?? runSamsaraSafetyEventsSync;

  let acquired: boolean;
  try {
    acquired = await tryAcquireLock(client, new Date());
  } catch (err) {
    console.error("[sync-lock] Failed to acquire sync lock:", err);
    return { status: "lock_acquire_failed" };
  }

  if (!acquired) {
    // Another caller already holds a live lock — do not stack a second
    // drain. This is the exact scenario that used to be possible between
    // the on-demand path and the ops route before this phase.
    return { status: "sync_in_progress" };
  }

  const controller = deps.timeoutMs !== undefined ? new AbortController() : undefined;
  const timeoutId =
    controller && deps.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), deps.timeoutMs)
      : undefined;

  try {
    const outcome = await runSync(controller?.signal);
    return { status: "acquired", outcome };
  } catch (err) {
    console.error("[sync-lock] Sync attempt threw:", err instanceof Error ? err.message : err);
    return { status: "sync_threw", error: err instanceof Error ? err.message : "Unknown error" };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    await releaseLock(client);
  }
}

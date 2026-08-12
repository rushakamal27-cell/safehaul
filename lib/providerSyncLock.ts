/**
 * lib/providerSyncLock.ts
 *
 * Phase 6B.6 — generalizes the DB-backed lock previously hardcoded to the
 * Samsara Safety Events (provider, streamKey) pair
 * (lib/providers/samsara/syncLock.ts, Phase 6B.5) into a provider-neutral
 * utility over ANY (provider, streamKey) row on ProviderSyncState. Needed
 * because Phase 6B.6 introduces a second, independent lock — the
 * pilot-observation-cycle job lock — that must reuse the exact same
 * mechanism without duplicating it (per this codebase's standing "Do not
 * duplicate locking logic" rule, first stated in Phase 6B.5).
 *
 * lib/providers/samsara/syncLock.ts now wraps this module, fixed to the
 * (samsara, safety-events) key — its own public API (withSamsaraSyncLock,
 * SyncLockOutcome, WithSamsaraSyncLockDeps) is unchanged, so nothing that
 * already depended on it (onDemandSync.ts, the Safety Events ops route,
 * every Phase 6B.5 test) needed to change.
 *
 * Everything below is otherwise IDENTICAL in behavior to Phase 6B.5's
 * syncLock.ts — see that file's own header (still present) for the full
 * concurrency-guard/staleness/timeout rationale, which applies unchanged
 * here regardless of which (provider, streamKey) row is being locked.
 */

import { prisma } from "@/lib/prisma";

const LOCK_STALE_MS = 20_000;

export interface ProviderSyncLockKey {
  provider: string;
  streamKey: string;
}

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
  key: ProviderSyncLockKey,
  now: Date
): Promise<boolean> {
  // Step 1: race-safe row creation + lock claim in one atomic INSERT.
  try {
    await client.create({
      data: { provider: key.provider, streamKey: key.streamKey, syncLockedAt: now },
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
      provider: key.provider,
      streamKey: key.streamKey,
      OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: staleBefore } }],
    },
    data: { syncLockedAt: now },
  });

  return claim.count === 1;
}

async function releaseLock(client: ProviderSyncStateClient, key: ProviderSyncLockKey): Promise<void> {
  await client
    .update({
      where: { provider_streamKey: { provider: key.provider, streamKey: key.streamKey } },
      data: { syncLockedAt: null },
    })
    .catch((err) => console.error(`[provider-sync-lock] Failed to release lock (${key.provider}/${key.streamKey}):`, err));
}

export type ProviderSyncLockOutcome<T> =
  | { status: "acquired"; result: T }
  | { status: "sync_in_progress" }
  | { status: "lock_acquire_failed" }
  | { status: "threw"; error: string };

export interface WithProviderSyncLockDeps<T> {
  key: ProviderSyncLockKey;
  /** Injectable for tests; defaults to the real Prisma delegate. */
  client?: ProviderSyncStateClient;
  run: (signal?: AbortSignal) => Promise<T>;
  /**
   * Bounds `run` via AbortController when set. Left undefined by default —
   * no forced cutoff — since an arbitrary timeout is not a safe default for
   * every caller. Callers embedded in a tight request budget must opt in
   * explicitly (see lib/providers/samsara/syncLock.ts's file header).
   */
  timeoutMs?: number;
}

/**
 * Attempts to claim the lock for `key` and, if successful, runs `run` under
 * it — releasing the lock in `finally` regardless of outcome. Never throws:
 * a lock-acquisition failure or a thrown `run` both resolve to a status
 * rather than propagating, so every caller gets a uniform, exhaustive
 * result to switch on.
 */
export async function withProviderSyncLock<T>(
  deps: WithProviderSyncLockDeps<T>
): Promise<ProviderSyncLockOutcome<T>> {
  const client = deps.client ?? (prisma.providerSyncState as unknown as ProviderSyncStateClient);

  let acquired: boolean;
  try {
    acquired = await tryAcquireLock(client, deps.key, new Date());
  } catch (err) {
    console.error(`[provider-sync-lock] Failed to acquire lock (${deps.key.provider}/${deps.key.streamKey}):`, err);
    return { status: "lock_acquire_failed" };
  }

  if (!acquired) {
    return { status: "sync_in_progress" };
  }

  const controller = deps.timeoutMs !== undefined ? new AbortController() : undefined;
  const timeoutId =
    controller && deps.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), deps.timeoutMs)
      : undefined;

  try {
    const result = await deps.run(controller?.signal);
    return { status: "acquired", result };
  } catch (err) {
    console.error(
      `[provider-sync-lock] run() threw (${deps.key.provider}/${deps.key.streamKey}):`,
      err instanceof Error ? err.message : err
    );
    return { status: "threw", error: err instanceof Error ? err.message : "Unknown error" };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    await releaseLock(client, deps.key);
  }
}

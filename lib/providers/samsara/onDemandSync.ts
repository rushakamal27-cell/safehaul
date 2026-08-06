/**
 * lib/providers/samsara/onDemandSync.ts
 *
 * On-demand freshness check for pilot drivers, called from /api/risk before
 * scoring a Heads-Up request. Replaces the removed 5-minute Vercel Cron (the
 * project's Hobby plan cannot run it reliably): instead, the first request
 * that finds Samsara data stale triggers a refresh inline.
 *
 * Concurrency guard:
 *   Multiple Heads-Up requests can arrive at the same instant across separate
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
 *   Losers of either step skip syncing and fall back to whatever DriverEvents
 *   already exist — they do not wait on the winner. RawProviderEvent's unique
 *   constraint remains a second line of defense against duplicate event rows
 *   regardless.
 *
 * Timeout:
 *   Bounded to 6s via AbortController, which actually cancels the in-flight
 *   Samsara fetch (not just the awaiting promise). Chosen because Vercel's
 *   Hobby plan defaults serverless functions to a 10s execution limit — 6s
 *   leaves headroom for the rest of /api/risk (parallel lookups, trip/score
 *   writes) to complete after the sync attempt resolves either way.
 *
 * Lock staleness:
 *   Set well above the sync timeout (20s vs 6s) so a lock is never reclaimed
 *   out from under a sync that is still legitimately running — it only
 *   protects against a lock left behind by a crashed/killed instance.
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
 *                         syncing (or holds a not-yet-stale lock).
 *   There is deliberately no separate "no sync state" status: a missing or
 *   unreadable ProviderSyncState row is treated as "not fresh" and funnels
 *   into the same refresh attempt as a stale row, resolving to one of the
 *   four statuses above — never an ambiguous combination.
 */

import { prisma } from "@/lib/prisma";
import {
  runSamsaraSafetyEventsSync,
  PROVIDER,
  STREAM_KEY,
  type SamsaraSyncOutcome,
} from "./syncSafetyEvents";

const FRESHNESS_MS = 5 * 60 * 1000; // matches the product spec's staleness threshold — see docs/data-freshness.md for how this compares to the other freshness thresholds in the codebase
const SYNC_TIMEOUT_MS = 6_000;
const LOCK_STALE_MS = 20_000;

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
    .catch((err) => console.error("[on-demand-sync] Failed to release lock:", err));
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
  const runSync = deps.runSync ?? runSamsaraSafetyEventsSync;
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

  // Missing, stale, or unreadable sync state — all funnel into "attempt a refresh".
  let acquired: boolean;
  try {
    acquired = await tryAcquireLock(client, new Date());
  } catch (err) {
    console.error("[on-demand-sync] Failed to acquire sync lock:", err);
    return { status: "refresh_failed", previousLastSyncAt, elapsedMs: elapsed() };
  }

  if (!acquired) {
    // Another instance already holds a live lock — do not stack a second sync.
    return { status: "sync_in_progress", previousLastSyncAt, elapsedMs: elapsed() };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const outcome = await runSync(controller.signal);
    return {
      status: outcome.synced ? "refreshed" : "refresh_failed",
      previousLastSyncAt,
      elapsedMs: elapsed(),
    };
  } catch (err) {
    console.error(
      "[on-demand-sync] Sync attempt threw:",
      err instanceof Error ? err.message : err
    );
    return { status: "refresh_failed", previousLastSyncAt, elapsedMs: elapsed() };
  } finally {
    clearTimeout(timeoutId);
    await releaseLock(client);
  }
}

/**
 * Targeted tests for the shared Safety Events sync lock
 * (lib/providers/samsara/syncLock.ts), including the Phase 6B.5
 * cross-path concurrency scenario: an on-demand caller (ensureFreshSamsaraSync)
 * and a manual/scheduled ops caller (withSamsaraSyncLock directly, mirroring
 * app/api/sync/samsara-safety-events/route.ts) racing against the SAME
 * ProviderSyncState row. ProviderSyncStateClient is faked entirely
 * in-memory, same synchronous check-and-mutate approach as
 * onDemandSync.test.ts (mirrors a real atomic SQL statement).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { withSamsaraSyncLock, type ProviderSyncStateClient } from "../syncLock";
import { ensureFreshSamsaraSync } from "../onDemandSync";
import type { SamsaraSyncOutcome, SamsaraSyncStats } from "../syncSafetyEvents";

interface FakeRow {
  lastSyncAt: Date | null;
  syncLockedAt: Date | null;
}

function makeFakeClient(initialRow: FakeRow | null) {
  let row: FakeRow | null = initialRow;

  const client: ProviderSyncStateClient = {
    async findUnique() {
      if (!row) return null;
      return { lastSyncAt: row.lastSyncAt };
    },
    async create({ data }) {
      if (row) {
        const err = new Error("Unique constraint failed") as Error & { code: string };
        err.code = "P2002";
        throw err;
      }
      row = { lastSyncAt: null, syncLockedAt: data.syncLockedAt };
    },
    async updateMany({ where, data }) {
      if (!row) return { count: 0 };
      const staleBefore = where.OR[1].syncLockedAt.lt;
      const claimable = row.syncLockedAt === null || row.syncLockedAt < staleBefore;
      if (!claimable) return { count: 0 };
      row.syncLockedAt = data.syncLockedAt;
      return { count: 1 };
    },
    async update({ data }) {
      if (row) row.syncLockedAt = data.syncLockedAt;
    },
  };

  return { client, getRow: () => row };
}

const emptyStats: SamsaraSyncStats = {
  pagesProcessed: 1,
  eventsProcessed: 0,
  eventsSkipped: 0,
  skipReasons: {
    no_driver_id: 0,
    unsupported_behavior_label: 0,
    no_timestamp: 0,
    unexpected_error: 0,
  },
  unsupportedLabelsFound: {},
  duplicates: 0,
  driverEventsCreated: 0,
  newDriverEventIds: [],
};

const emptyEnrichment = {
  eventsCreated: 0,
  enrichmentAttempted: 0,
  enrichmentCreated: 0,
  enrichmentSkipped: 0,
  enrichmentFailed: 0,
};

function successOutcome(): SamsaraSyncOutcome {
  return { synced: true, skipped: false, cursor: "cursor-1", elapsedMs: 5, ...emptyStats, enrichment: emptyEnrichment };
}

test("withSamsaraSyncLock — cold start: acquires the lock and runs the sync", async () => {
  const { client, getRow } = makeFakeClient(null);
  let calls = 0;

  const result = await withSamsaraSyncLock({
    client,
    runSync: async () => {
      calls++;
      return successOutcome();
    },
  });

  assert.equal(result.status, "acquired");
  if (result.status === "acquired") assert.equal(result.outcome.synced, true);
  assert.equal(calls, 1);
  assert.equal(getRow()?.syncLockedAt, null, "lock must be released after success");
});

test("withSamsaraSyncLock — a live lock held by another caller resolves to sync_in_progress without calling runSync", async () => {
  const { client } = makeFakeClient({ lastSyncAt: null, syncLockedAt: new Date() });
  let calls = 0;

  const result = await withSamsaraSyncLock({
    client,
    runSync: async () => {
      calls++;
      return successOutcome();
    },
  });

  assert.equal(result.status, "sync_in_progress");
  assert.equal(calls, 0);
});

test("withSamsaraSyncLock — a stale lock (older than 20s) can still be reclaimed", async () => {
  const staleLock = new Date(Date.now() - 30_000);
  const { client, getRow } = makeFakeClient({ lastSyncAt: null, syncLockedAt: staleLock });

  const result = await withSamsaraSyncLock({
    client,
    runSync: async () => successOutcome(),
  });

  assert.equal(result.status, "acquired");
  assert.equal(getRow()?.syncLockedAt, null, "lock must be released after success");
});

test("withSamsaraSyncLock — no timeoutMs means no forced cutoff (a slow sync still completes)", async () => {
  const { client } = makeFakeClient(null);

  const result = await withSamsaraSyncLock({
    client,
    // No timeoutMs passed — mirrors the manual ops route, which must be
    // allowed to run a full catch-up drain.
    runSync: async (signal) => {
      assert.equal(signal, undefined, "no AbortSignal should be created when timeoutMs is not set");
      await new Promise((r) => setTimeout(r, 30));
      return successOutcome();
    },
  });

  assert.equal(result.status, "acquired");
});

test("withSamsaraSyncLock — timeout: a hanging sync is aborted and resolves to sync_threw, lock still released", async () => {
  const { client, getRow } = makeFakeClient(null);

  const hangingRunSync = (signal?: AbortSignal): Promise<SamsaraSyncOutcome> =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
    });

  const result = await withSamsaraSyncLock({
    client,
    runSync: hangingRunSync,
    timeoutMs: 25, // short bound so the test doesn't wait a real timeout
  });

  assert.equal(result.status, "sync_threw");
  if (result.status === "sync_threw") assert.match(result.error, /aborted/);
  assert.equal(getRow()?.syncLockedAt, null, "lock must still be released after a timeout");
});

test("withSamsaraSyncLock — a thrown sync error (not just a timeout) still releases the lock and resolves to sync_threw", async () => {
  const { client, getRow } = makeFakeClient(null);

  const result = await withSamsaraSyncLock({
    client,
    runSync: async () => {
      throw new Error("Samsara returned 500");
    },
  });

  assert.equal(result.status, "sync_threw");
  if (result.status === "sync_threw") assert.equal(result.error, "Samsara returned 500");
  assert.equal(getRow()?.syncLockedAt, null);
});

test("withSamsaraSyncLock — lock acquisition itself failing (DB error) resolves to lock_acquire_failed", async () => {
  const client: ProviderSyncStateClient = {
    async findUnique() { return null; },
    async create() { throw new Error("connection reset"); },
    async updateMany() { throw new Error("connection reset"); },
    async update() {},
  };

  const result = await withSamsaraSyncLock({ client, runSync: async () => successOutcome() });
  assert.equal(result.status, "lock_acquire_failed");
});

test("withSamsaraSyncLock — two simultaneous callers: exactly one acquires, the other reports sync_in_progress", async () => {
  const { client, getRow } = makeFakeClient(null);
  let syncCalls = 0;

  const runSync = async (): Promise<SamsaraSyncOutcome> => {
    syncCalls++;
    await new Promise((r) => setTimeout(r, 5));
    return successOutcome();
  };

  const [a, b] = await Promise.all([
    withSamsaraSyncLock({ client, runSync }),
    withSamsaraSyncLock({ client, runSync }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["acquired", "sync_in_progress"]);
  assert.equal(syncCalls, 1, "only the lock winner may call the sync operation");
  assert.equal(getRow()?.syncLockedAt, null, "winner must release the lock in finally");
});

// ---------------------------------------------------------------------------
// Phase 6B.5, Step 2: explicit cross-path concurrency test.
// This is the scenario the phase exists to fix: an on-demand /api/risk
// caller and a manual/future-scheduled ops caller (app/api/sync/
// samsara-safety-events, here represented directly via withSamsaraSyncLock,
// the exact function that route now calls) racing against the SAME
// ProviderSyncState row. Before Phase 6B.5, the ops path bypassed the lock
// entirely and both could have run concurrently.
// ---------------------------------------------------------------------------

test("cross-path concurrency: on-demand sync and a manual ops sync racing the SAME lock — only one drain runs, cursor state is never mutated by both", async () => {
  const { client, getRow } = makeFakeClient(null); // cold start, both paths see "not fresh"
  let drainCalls = 0;
  const cursorWrites: (string | null)[] = [];

  const runSync = async (): Promise<SamsaraSyncOutcome> => {
    drainCalls++;
    // Yield so both callers are genuinely in flight together, mirroring two
    // requests landing at nearly the same instant.
    await new Promise((r) => setTimeout(r, 5));
    cursorWrites.push("cursor-from-this-drain");
    return successOutcome();
  };

  // A: /api/risk's on-demand path.
  const onDemandCall = ensureFreshSamsaraSync({ client, runSync });
  // B: the manual/future-scheduled ops route's own call (no timeoutMs,
  // exactly matching app/api/sync/samsara-safety-events/route.ts).
  const opsCall = withSamsaraSyncLock({ client, runSync });

  const [onDemandResult, opsResult] = await Promise.all([onDemandCall, opsCall]);

  // Exactly one Samsara drain ran — the other caller never fetched the
  // stream, never advanced the cursor, never mutated cursorStartTime.
  assert.equal(drainCalls, 1, "only one of the two callers may run the underlying drain");
  assert.equal(cursorWrites.length, 1, "cursor-affecting work happened exactly once");

  // The on-demand path reports one of its own three post-freshness-check
  // statuses; the ops path reports the matching shared-lock status. Exactly
  // one pair member reflects "I ran the sync", the other "someone else did".
  const onDemandRan = onDemandResult.status === "refreshed";
  const onDemandLost = onDemandResult.status === "sync_in_progress";
  const opsRan = opsResult.status === "acquired";
  const opsLost = opsResult.status === "sync_in_progress";

  assert.ok(onDemandRan !== opsRan, "exactly one caller must be the one that actually ran the sync");
  assert.ok(
    (onDemandRan && opsLost) || (opsRan && onDemandLost),
    `expected one winner and one sync_in_progress loser, got onDemand=${onDemandResult.status} ops=${opsResult.status}`
  );

  assert.equal(getRow()?.syncLockedAt, null, "the winner must release the lock in finally regardless of which caller won");
});

test("cross-path concurrency: if the ops caller wins, the on-demand caller correctly reports sync_in_progress (not a false freshness read)", async () => {
  const { client } = makeFakeClient(null);

  const runSync = async (): Promise<SamsaraSyncOutcome> => {
    await new Promise((r) => setTimeout(r, 10));
    return successOutcome();
  };

  // Start the ops call first so it reliably wins the race, then start the
  // on-demand call a tick later — still concurrent (ops hasn't resolved
  // yet), but deterministic about which one wins for this assertion.
  const opsCall = withSamsaraSyncLock({ client, runSync });
  await new Promise((r) => setTimeout(r, 1));
  const onDemandCall = ensureFreshSamsaraSync({ client, runSync });

  const [opsResult, onDemandResult] = await Promise.all([opsCall, onDemandCall]);

  assert.equal(opsResult.status, "acquired");
  assert.equal(
    onDemandResult.status,
    "sync_in_progress",
    "the on-demand caller must recognize the ops sync already in flight, never double-drain"
  );
});

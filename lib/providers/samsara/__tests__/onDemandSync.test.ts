/**
 * Targeted tests for the on-demand sync lock/status decision logic
 * (lib/providers/samsara/onDemandSync.ts).
 *
 * Run with: node --test lib/providers/samsara/__tests__/onDemandSync.test.ts
 * (Node 24's native TypeScript support + built-in test runner — no framework
 * or extra dependency required.)
 *
 * ProviderSyncStateClient is faked entirely in-memory. The fake's create()
 * and updateMany() do their check-and-mutate synchronously with no internal
 * await, exactly mirroring a single atomic SQL statement (a real INSERT or
 * UPDATE cannot be interrupted mid-statement by a concurrent connection) —
 * so concurrent-request tests genuinely exercise the same "exactly one
 * winner" race logic that Postgres guarantees in production, even though no
 * real database is involved.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureFreshSamsaraSync,
  type ProviderSyncStateClient,
} from "../onDemandSync";
import type { SamsaraSyncOutcome, SamsaraSyncStats } from "../syncSafetyEvents";

const PROVIDER = "samsara";
const STREAM_KEY = "safety-events";

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
};

function successOutcome(driverEventsCreated: number): SamsaraSyncOutcome {
  return {
    synced: true,
    skipped: false,
    cursor: "cursor-1",
    elapsedMs: 5,
    ...emptyStats,
    driverEventsCreated,
  };
}

function failureOutcome(error: string): SamsaraSyncOutcome {
  return { synced: false, error, elapsedMs: 5, ...emptyStats };
}

test("no ProviderSyncState row (cold start): single request acquires lock and syncs", async () => {
  const { client, getRow } = makeFakeClient(null);
  let calls = 0;
  const decision = await ensureFreshSamsaraSync({
    client,
    runSync: async () => {
      calls++;
      return successOutcome(0);
    },
  });

  assert.equal(decision.status, "refreshed");
  assert.equal(decision.previousLastSyncAt, null);
  assert.equal(calls, 1);
  assert.equal(getRow()?.syncLockedAt, null, "lock must be released after success");
});

test("one stale existing row: request acquires lock and syncs", async () => {
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  const { client, getRow } = makeFakeClient({ lastSyncAt: staleTime, syncLockedAt: null });

  const decision = await ensureFreshSamsaraSync({
    client,
    runSync: async () => successOutcome(2),
  });

  assert.equal(decision.status, "refreshed");
  assert.equal(decision.previousLastSyncAt?.getTime(), staleTime.getTime());
  assert.equal(getRow()?.syncLockedAt, null, "lock must be released after success");
});

test("fresh row: no lock, no sync attempt", async () => {
  const recent = new Date(Date.now() - 60 * 1000); // 1 minute ago
  const { client } = makeFakeClient({ lastSyncAt: recent, syncLockedAt: null });
  let calls = 0;

  const decision = await ensureFreshSamsaraSync({
    client,
    runSync: async () => {
      calls++;
      return successOutcome(0);
    },
  });

  assert.equal(decision.status, "fresh");
  assert.equal(calls, 0, "runSync must not be called when data is fresh");
});

test("two simultaneous cold-start requests: exactly one syncs, the other reports sync_in_progress, no duplicate rows", async () => {
  const { client, getRow } = makeFakeClient(null);
  let syncCalls = 0;

  const runSync = async (): Promise<SamsaraSyncOutcome> => {
    syncCalls++;
    // Yield a tick so both requests are genuinely in flight together.
    await new Promise((r) => setTimeout(r, 5));
    return successOutcome(1);
  };

  const [a, b] = await Promise.all([
    ensureFreshSamsaraSync({ client, runSync }),
    ensureFreshSamsaraSync({ client, runSync }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["refreshed", "sync_in_progress"]);
  assert.equal(syncCalls, 1, "only the lock winner may call the sync operation");
  assert.equal(getRow()?.syncLockedAt, null, "winner must release the lock in finally");
});

test("two simultaneous stale-state requests: exactly one syncs, the other reports sync_in_progress", async () => {
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  const { client, getRow } = makeFakeClient({ lastSyncAt: staleTime, syncLockedAt: null });
  let syncCalls = 0;

  const runSync = async (): Promise<SamsaraSyncOutcome> => {
    syncCalls++;
    await new Promise((r) => setTimeout(r, 5));
    return successOutcome(3);
  };

  const [a, b] = await Promise.all([
    ensureFreshSamsaraSync({ client, runSync }),
    ensureFreshSamsaraSync({ client, runSync }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["refreshed", "sync_in_progress"]);
  assert.equal(syncCalls, 1);
  assert.equal(getRow()?.syncLockedAt, null);
});

test("timeout: sync exceeding the bounded wait resolves to refresh_failed and releases the lock", async () => {
  const { client, getRow } = makeFakeClient(null);

  const hangingRunSync = (signal?: AbortSignal): Promise<SamsaraSyncOutcome> =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(new Error("This operation was aborted"));
      });
    });

  const decision = await ensureFreshSamsaraSync({
    client,
    runSync: hangingRunSync,
    timeoutMs: 25, // short bound so the test doesn't wait the real 6s
  });

  assert.equal(decision.status, "refresh_failed");
  assert.equal(getRow()?.syncLockedAt, null, "lock must still be released after a timeout");
});

test("Samsara error: sync failure resolves to refresh_failed and releases the lock", async () => {
  const { client, getRow } = makeFakeClient(null);

  const decision = await ensureFreshSamsaraSync({
    client,
    runSync: async () => failureOutcome("Samsara Safety Events Stream returned 500"),
  });

  assert.equal(decision.status, "refresh_failed");
  assert.equal(getRow()?.syncLockedAt, null);
});

test("successful sync with zero new events still reports refreshed", async () => {
  const { client } = makeFakeClient(null);

  const decision = await ensureFreshSamsaraSync({
    client,
    runSync: async () => successOutcome(0),
  });

  assert.equal(decision.status, "refreshed");
});

test("successful sync with new events reports refreshed", async () => {
  const { client } = makeFakeClient(null);

  const decision = await ensureFreshSamsaraSync({
    client,
    runSync: async () => successOutcome(7),
  });

  assert.equal(decision.status, "refreshed");
});

test("unreadable sync state (findUnique throws) still resolves to a deterministic status, never an ambiguous one", async () => {
  const client: ProviderSyncStateClient = {
    async findUnique() {
      throw new Error("connection reset");
    },
    async create({ data }) {
      // Simulate cold start once the read failure is worked around.
      void data;
    },
    async updateMany() {
      return { count: 1 };
    },
    async update() {},
  };

  const decision = await ensureFreshSamsaraSync({
    client,
    runSync: async () => successOutcome(0),
  });

  assert.equal(decision.previousLastSyncAt, null);
  assert.ok(
    ["refreshed", "refresh_failed", "sync_in_progress"].includes(decision.status),
    `status must be one of the three canonical outcomes, got "${decision.status}"`
  );
});

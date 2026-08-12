/**
 * Targeted tests for the provider-neutral DB-backed lock
 * (lib/providerSyncLock.ts). Most of this mechanism's behavior is already
 * exhaustively covered indirectly via lib/providers/samsara/__tests__/
 * syncLock.test.ts (withSamsaraSyncLock now delegates to this module
 * entirely) — this file focuses specifically on what that indirect coverage
 * CAN'T exercise: that two different (provider, streamKey) keys are
 * genuinely independent locks, which is the whole reason Phase 6B.6 needed
 * this generalization (the job lock and the Safety Events lock must never
 * interfere with each other).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { withProviderSyncLock, type ProviderSyncStateClient } from "../providerSyncLock";

interface FakeRow {
  provider: string;
  streamKey: string;
  syncLockedAt: Date | null;
}

function makeFakeClient(initialRows: FakeRow[] = []) {
  const rows = new Map<string, FakeRow>(initialRows.map((r) => [`${r.provider}::${r.streamKey}`, r]));

  const client: ProviderSyncStateClient = {
    async findUnique({ where }) {
      const row = rows.get(`${where.provider_streamKey.provider}::${where.provider_streamKey.streamKey}`);
      return row ? { lastSyncAt: null } : null;
    },
    async create({ data }) {
      const key = `${data.provider}::${data.streamKey}`;
      if (rows.has(key)) {
        const err = new Error("Unique constraint failed") as Error & { code: string };
        err.code = "P2002";
        throw err;
      }
      rows.set(key, { provider: data.provider, streamKey: data.streamKey, syncLockedAt: data.syncLockedAt });
    },
    async updateMany({ where, data }) {
      const key = `${where.provider}::${where.streamKey}`;
      const row = rows.get(key);
      if (!row) return { count: 0 };
      const staleBefore = where.OR[1].syncLockedAt.lt;
      const claimable = row.syncLockedAt === null || row.syncLockedAt < staleBefore;
      if (!claimable) return { count: 0 };
      row.syncLockedAt = data.syncLockedAt;
      return { count: 1 };
    },
    async update({ where, data }) {
      const row = rows.get(`${where.provider_streamKey.provider}::${where.provider_streamKey.streamKey}`);
      if (row) row.syncLockedAt = data.syncLockedAt;
    },
  };

  return { client, getRow: (provider: string, streamKey: string) => rows.get(`${provider}::${streamKey}`) };
}

test("withProviderSyncLock — cold start: acquires and runs", async () => {
  const { client, getRow } = makeFakeClient();
  let calls = 0;

  const result = await withProviderSyncLock({
    key: { provider: "samsara", streamKey: "pilot-observation-cycle" },
    client,
    run: async () => {
      calls++;
      return "done";
    },
  });

  assert.equal(result.status, "acquired");
  if (result.status === "acquired") assert.equal(result.result, "done");
  assert.equal(calls, 1);
  assert.equal(getRow("samsara", "pilot-observation-cycle")?.syncLockedAt, null);
});

test("withProviderSyncLock — a live lock on the SAME key blocks a second acquire", async () => {
  const { client } = makeFakeClient([
    { provider: "samsara", streamKey: "pilot-observation-cycle", syncLockedAt: new Date() },
  ]);

  const result = await withProviderSyncLock({
    key: { provider: "samsara", streamKey: "pilot-observation-cycle" },
    client,
    run: async () => "should not run",
  });

  assert.equal(result.status, "sync_in_progress");
});

test("withProviderSyncLock — two DIFFERENT keys are fully independent: a live lock on one never blocks the other", async () => {
  const { client } = makeFakeClient([
    { provider: "samsara", streamKey: "safety-events", syncLockedAt: new Date() }, // held
  ]);

  let jobCalls = 0;
  const jobResult = await withProviderSyncLock({
    key: { provider: "samsara", streamKey: "pilot-observation-cycle" }, // different key — untouched
    client,
    run: async () => {
      jobCalls++;
      return "job ran";
    },
  });

  assert.equal(jobResult.status, "acquired", "a lock held on safety-events must not block pilot-observation-cycle");
  assert.equal(jobCalls, 1);
});

test("withProviderSyncLock — a stale lock (older than 20s) on a given key can still be reclaimed for that same key", async () => {
  const staleLock = new Date(Date.now() - 30_000);
  const { client, getRow } = makeFakeClient([
    { provider: "samsara", streamKey: "pilot-observation-cycle", syncLockedAt: staleLock },
  ]);

  const result = await withProviderSyncLock({
    key: { provider: "samsara", streamKey: "pilot-observation-cycle" },
    client,
    run: async () => "reclaimed",
  });

  assert.equal(result.status, "acquired");
  assert.equal(getRow("samsara", "pilot-observation-cycle")?.syncLockedAt, null, "must be released after success");
});

test("withProviderSyncLock — lock is released in finally even when run() throws", async () => {
  const { client, getRow } = makeFakeClient();

  const result = await withProviderSyncLock({
    key: { provider: "samsara", streamKey: "pilot-observation-cycle" },
    client,
    run: async () => {
      throw new Error("boom");
    },
  });

  assert.equal(result.status, "threw");
  if (result.status === "threw") assert.equal(result.error, "boom");
  assert.equal(getRow("samsara", "pilot-observation-cycle")?.syncLockedAt, null, "lock must still be released");
});

test("withProviderSyncLock — no timeoutMs means run() receives no AbortSignal and is never cut off", async () => {
  const { client } = makeFakeClient();

  const result = await withProviderSyncLock({
    key: { provider: "samsara", streamKey: "pilot-observation-cycle" },
    client,
    run: async (signal) => {
      assert.equal(signal, undefined);
      await new Promise((r) => setTimeout(r, 20));
      return "completed slowly";
    },
  });

  assert.equal(result.status, "acquired");
});

test("withProviderSyncLock — two simultaneous callers on the SAME key: exactly one acquires", async () => {
  const { client, getRow } = makeFakeClient();
  let runCalls = 0;
  const run = async () => {
    runCalls++;
    await new Promise((r) => setTimeout(r, 5));
    return "ok";
  };

  const key = { provider: "samsara", streamKey: "pilot-observation-cycle" };
  const [a, b] = await Promise.all([
    withProviderSyncLock({ key, client, run }),
    withProviderSyncLock({ key, client, run }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["acquired", "sync_in_progress"]);
  assert.equal(runCalls, 1);
  assert.equal(getRow("samsara", "pilot-observation-cycle")?.syncLockedAt, null);
});

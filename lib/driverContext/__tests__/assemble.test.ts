import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { simulatedField, fieldStateForSyncStatus } from "../assemble";

// These two functions are the pure, easily-isolated pieces of assemble.ts.
// The rest of assembleDriverContext() is thin I/O orchestration over
// already-tested collaborators (onDemandSync has its own concurrency tests;
// the mock scenario getters are trivial), so it isn't re-tested here with a
// full dependency-injection harness — that would be more machinery than an
// MVP composition function warrants.

describe("simulatedField", () => {
  test("pilot driver: not-yet-integrated field is a fallback, no provider, no timestamp", () => {
    const f = simulatedField(6.0, true, "2026-07-13T00:00:00.000Z");
    assert.deepEqual(f, {
      value: 6.0,
      origin: "simulated",
      state: "fallback",
      provider: null,
      observedAt: null,
    });
  });

  test("demo driver: simulated field is fresh, internal, timestamped now", () => {
    const f = simulatedField(6.0, false, "2026-07-13T00:00:00.000Z");
    assert.deepEqual(f, {
      value: 6.0,
      origin: "simulated",
      state: "fresh",
      provider: "internal",
      observedAt: "2026-07-13T00:00:00.000Z",
    });
  });
});

describe("fieldStateForSyncStatus", () => {
  test("refreshed -> fresh", () => {
    assert.equal(fieldStateForSyncStatus("refreshed"), "fresh");
  });

  test("fresh (no-op, within window) -> cached", () => {
    assert.equal(fieldStateForSyncStatus("fresh"), "cached");
  });

  test("sync_in_progress -> cached (stored events remain real, just not just-confirmed)", () => {
    assert.equal(fieldStateForSyncStatus("sync_in_progress"), "cached");
  });

  test("refresh_failed -> cached (stored events remain real, just not just-confirmed)", () => {
    assert.equal(fieldStateForSyncStatus("refresh_failed"), "cached");
  });
});

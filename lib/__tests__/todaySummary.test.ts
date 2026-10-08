import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { utcDayBounds, resolveMilesDriven } from "../todaySummary";

// utcDayBounds is the pure, easily-isolated piece of todaySummary.ts. The
// rest (resolveChecksPassed, resolveVehicleId, resolveMilesDriven) hits
// Prisma/Samsara directly and follows the same "not re-tested with a full
// DI harness" precedent already established for assembleDriverContext in
// lib/driverContext/__tests__/assemble.test.ts.

describe("utcDayBounds", () => {
  test("returns UTC midnight-to-midnight bounds for a mid-day instant", () => {
    const { start, end } = utcDayBounds(new Date("2026-07-14T15:30:00.000Z"));
    assert.equal(start.toISOString(), "2026-07-14T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-07-15T00:00:00.000Z");
  });

  test("an instant already at UTC midnight stays the start of that day", () => {
    const { start, end } = utcDayBounds(new Date("2026-07-14T00:00:00.000Z"));
    assert.equal(start.toISOString(), "2026-07-14T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-07-15T00:00:00.000Z");
  });
});

// Remove Implicit Demo Fallback (2026-10-08). The non-pilot branch of
// resolveMilesDriven used to return a mock scenario constant
// (156/203/487/621 mi) reported as status "available" — the most visible
// fabricated number in the product, and the source of the 487 mi that showed
// up on a real Trip row. It now returns null/"unavailable" with no I/O at
// all, which is why this needs no Prisma or Samsara harness.
describe("resolveMilesDriven — non-pilot drivers", () => {
  const DAY_START = new Date("2026-10-08T00:00:00.000Z");
  const DAY_END   = new Date("2026-10-09T00:00:00.000Z");

  test("never-mapped account: mileage is null and unavailable, never a scenario constant", async () => {
    const result = await resolveMilesDriven("never-mapped-account-id", false, DAY_START, DAY_END);
    assert.deepEqual(result, { milesDriven: null, status: "unavailable" });
  });

  test("deactivated / former pilot: same answer — deactivation must not switch to synthetic data", async () => {
    const result = await resolveMilesDriven("deactivated-former-pilot-id", false, DAY_START, DAY_END);
    assert.deepEqual(result, { milesDriven: null, status: "unavailable" });
  });

  test("the four known scenario mileage constants can no longer be produced", async () => {
    // 487 is the specific value that was found written to a production Trip
    // row; the other three are the remaining scenarios in lib/mockScenarios.ts.
    const fabricated = [156, 203, 487, 621];
    for (const id of ["a", "driver-b", "cmt83yb2h0001vdfd5vhi77pl", "zzzz"]) {
      const { milesDriven } = await resolveMilesDriven(id, false, DAY_START, DAY_END);
      assert.equal(milesDriven, null);
      assert.ok(!fabricated.includes(milesDriven as unknown as number));
    }
  });

  test("resolves without touching the network — no fetch, no provider token needed", async () => {
    // If the non-pilot path ever regains an I/O call this fails loudly rather
    // than silently depending on ambient credentials.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("non-pilot mileage must not perform I/O"); }) as typeof fetch;
    try {
      const result = await resolveMilesDriven("no-io-driver", false, DAY_START, DAY_END);
      assert.equal(result.status, "unavailable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { utcDayBounds } from "../todaySummary";

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

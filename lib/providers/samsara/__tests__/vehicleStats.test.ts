import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { odometerDeltaMiles, METERS_PER_MILE } from "../vehicleStats";

describe("odometerDeltaMiles", () => {
  test("computes delta between first and last reading, converts meters to miles", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T00:00:10Z", value: 95189915 },
      { time: "2026-07-15T02:52:24Z", value: 95189915 + METERS_PER_MILE * 178 },
    ]);
    assert.equal(Math.round(miles!), 178);
  });

  test("sorts out-of-order readings before computing delta", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T05:00:00Z", value: 1000 + METERS_PER_MILE * 10 },
      { time: "2026-07-15T00:00:00Z", value: 1000 },
    ]);
    assert.equal(Math.round(miles!), 10);
  });

  test("fewer than 2 valid readings -> null (can't compute a delta)", () => {
    assert.equal(odometerDeltaMiles([]), null);
    assert.equal(odometerDeltaMiles([{ time: "2026-07-15T00:00:00Z", value: 1000 }]), null);
  });

  test("readings missing time or value are ignored, not thrown", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T00:00:00Z", value: 1000 },
      { time: undefined, value: 999999 } as { time?: string; value?: number },
      { time: "2026-07-15T01:00:00Z", value: 1000 + METERS_PER_MILE * 5 },
    ]);
    assert.equal(Math.round(miles!), 5);
  });

  test("negative delta (odometer rollback / data anomaly) -> null, not a fabricated 0", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T00:00:00Z", value: 5000 },
      { time: "2026-07-15T01:00:00Z", value: 4000 },
    ]);
    assert.equal(miles, null);
  });

  test("zero delta (vehicle idle all day) -> 0, a real answer, not unavailable", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T00:00:00Z", value: 5000 },
      { time: "2026-07-15T12:00:00Z", value: 5000 },
    ]);
    assert.equal(miles, 0);
  });
});

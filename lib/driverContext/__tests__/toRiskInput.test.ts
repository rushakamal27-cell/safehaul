import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toRiskInput } from "../toRiskInput";
import type { DriverContext, DriverContextField } from "../types";

function field<T>(overrides: Partial<DriverContextField<T>> = {}): DriverContextField<T> {
  return {
    value: null,
    origin: null,
    state: "unavailable",
    provider: null,
    observedAt: null,
    ...overrides,
  };
}

function baseContext(overrides: Partial<DriverContext> = {}): DriverContext {
  return {
    driverId: "drv_1",
    safetyEvents: field({ value: [], origin: "simulated", state: "fresh", provider: "internal", observedAt: "2026-07-13T00:00:00.000Z" }),
    hos: field({ value: 3.5, origin: "simulated", state: "fresh", provider: "internal", observedAt: "2026-07-13T00:00:00.000Z" }),
    speed: field({ value: 62, origin: "simulated", state: "fresh", provider: "internal", observedAt: "2026-07-13T00:00:00.000Z" }),
    weather: field({ value: 0.1, origin: "simulated", state: "fresh", provider: "internal", observedAt: "2026-07-13T00:00:00.000Z" }),
    zoneRisk: field({ value: 0.1, origin: "simulated", state: "fresh", provider: "internal", observedAt: "2026-07-13T00:00:00.000Z" }),
    ...overrides,
  };
}

describe("toRiskInput", () => {
  test("passes through present values unchanged", () => {
    const ctx = baseContext();
    const input = toRiskInput(ctx);
    assert.deepEqual(input, {
      safetyEvents: [],
      hosHours: 3.5,
      weatherRisk: 0.1,
      zoneRisk: 0.1,
      speed: 62,
    });
  });

  test("passes through real safety events unchanged", () => {
    const events = [{ type: "harsh_braking", severity: 3 }];
    const ctx = baseContext({
      safetyEvents: field({ value: events, origin: "observed", state: "fresh", provider: "samsara", observedAt: "2026-07-13T00:00:00.000Z" }),
    });
    assert.deepEqual(toRiskInput(ctx).safetyEvents, events);
  });

  test("defaults unavailable safetyEvents to an empty array", () => {
    const ctx = baseContext({ safetyEvents: field({ state: "unavailable" }) });
    assert.deepEqual(toRiskInput(ctx).safetyEvents, []);
  });

  test("passes through unavailable hos as null (not defaulted to 0)", () => {
    const ctx = baseContext({ hos: field({ state: "unavailable" }) });
    assert.equal(toRiskInput(ctx).hosHours, null);
  });

  test("defaults unavailable weather to 0", () => {
    const ctx = baseContext({ weather: field({ state: "unavailable" }) });
    assert.equal(toRiskInput(ctx).weatherRisk, 0);
  });

  test("defaults unavailable zoneRisk to 0", () => {
    const ctx = baseContext({ zoneRisk: field({ state: "unavailable" }) });
    assert.equal(toRiskInput(ctx).zoneRisk, 0);
  });

  test("defaults unavailable speed to 0", () => {
    const ctx = baseContext({ speed: field({ state: "unavailable" }) });
    assert.equal(toRiskInput(ctx).speed, 0);
  });

  test("a value of 0 is preserved, not treated as missing", () => {
    const ctx = baseContext({
      hos: field({ value: 0, origin: "observed", state: "fresh", provider: "samsara", observedAt: "2026-07-13T00:00:00.000Z" }),
    });
    assert.equal(toRiskInput(ctx).hosHours, 0);
  });
});

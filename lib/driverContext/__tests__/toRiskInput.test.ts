import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toRiskInput } from "../toRiskInput";
import { calculateRisk } from "../../riskEngine";
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
    location: field({ value: { latitude: 33.749, longitude: -84.388 }, origin: "simulated", state: "fresh", provider: "internal", observedAt: "2026-07-13T00:00:00.000Z" }),
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
      weatherAvailable: true,
      zoneRiskAvailable: true,
      hosAvailable: true,
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

  // Phase 4.5 — Contextual Speed: *Available flags let the risk engine tell
  // "genuinely unavailable, defaulted to 0/null" apart from "a real reading
  // that happens to be 0" without importing DriverContextField itself.
  describe("*Available flags (Phase 4.5)", () => {
    test("weatherAvailable is false when weather is unavailable", () => {
      const ctx = baseContext({ weather: field({ state: "unavailable" }) });
      assert.equal(toRiskInput(ctx).weatherAvailable, false);
    });

    test("zoneRiskAvailable is false when zoneRisk is unavailable", () => {
      const ctx = baseContext({ zoneRisk: field({ state: "unavailable" }) });
      assert.equal(toRiskInput(ctx).zoneRiskAvailable, false);
    });

    test("hosAvailable is false when hos is unavailable", () => {
      const ctx = baseContext({ hos: field({ state: "unavailable" }) });
      assert.equal(toRiskInput(ctx).hosAvailable, false);
    });

    test("a real reading of exactly 0 still counts as available", () => {
      const ctx = baseContext({
        weather: field({ value: 0, origin: "observed", state: "fresh", provider: "openweather", observedAt: "2026-07-13T00:00:00.000Z" }),
      });
      assert.equal(toRiskInput(ctx).weatherAvailable, true);
    });
  });
});

// Phase 4.5 — end-to-end check that a pilot driver's real safety events +
// real speed, combined with unavailable weather/zone/HOS (the honest
// "unavailable", never "mock", outcome for a pilot per assemble.ts), never
// silently amplifies the contextual speed penalty through toRiskInput's
// availability flags reaching calculateRisk.
describe("toRiskInput -> calculateRisk integration (Phase 4.5)", () => {
  test("pilot context with real speed but unavailable weather/zone/hos does not amplify the speed penalty", () => {
    const ctx = baseContext({
      safetyEvents: field({ value: [], origin: "observed", state: "fresh", provider: "samsara", observedAt: "2026-07-13T00:00:00.000Z" }),
      speed: field({ value: 90, origin: "observed", state: "fresh", provider: "samsara", observedAt: "2026-07-13T00:00:00.000Z" }),
      weather: field({ state: "unavailable" }),
      zoneRisk: field({ state: "unavailable" }),
      hos: field({ state: "unavailable" }),
    });
    const input = toRiskInput(ctx);
    const result = calculateRisk(input);

    assert.equal(result.contextualSpeed.multiplier, 1);
    assert.equal(result.contextualSpeed.finalPenalty, result.contextualSpeed.speedExposure);
    assert.equal(result.contextualSpeed.contextComplete, false);
    assert.deepEqual(result.contextualSpeed.missingContext, ["Weather", "Zone risk", "HOS"]);
  });

  test("pilot context with all real fields fully amplifies and reports contextComplete", () => {
    const ctx = baseContext({
      speed:    field({ value: 90,  origin: "observed", state: "fresh", provider: "samsara",     observedAt: "2026-07-13T00:00:00.000Z" }),
      weather:  field({ value: 0.8, origin: "observed", state: "fresh", provider: "openweather",  observedAt: "2026-07-13T00:00:00.000Z" }),
      zoneRisk: field({ value: 0.6, origin: "observed", state: "fresh", provider: "internal_geofence", observedAt: "2026-07-13T00:00:00.000Z" }),
      hos:      field({ value: 10,  origin: "observed", state: "fresh", provider: "samsara",     observedAt: "2026-07-13T00:00:00.000Z" }),
    });
    const result = calculateRisk(toRiskInput(ctx));

    assert.ok(result.contextualSpeed.multiplier > 1);
    assert.equal(result.contextualSpeed.contextComplete, true);
    assert.deepEqual(result.contextualSpeed.missingContext, []);
  });
});

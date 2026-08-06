import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveContextStatus, deriveDataCompleteness } from "../contextStatus";
import { toContextSources } from "../toContextSources";
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

const OBSERVED_FRESH = { origin: "observed" as const, state: "fresh" as const, provider: "samsara" as const, observedAt: "2026-07-13T00:00:00.000Z" };
const OBSERVED_CACHED = { origin: "observed" as const, state: "cached" as const, provider: "samsara" as const, observedAt: "2026-07-13T00:00:00.000Z" };
const SIMULATED_FRESH = { origin: "simulated" as const, state: "fresh" as const, provider: "internal" as const, observedAt: "2026-07-13T00:00:00.000Z" };
const SIMULATED_FALLBACK = { origin: "simulated" as const, state: "fallback" as const, provider: null, observedAt: null };
const UNAVAILABLE = { origin: null, state: "unavailable" as const, provider: null, observedAt: null };

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  return {
    driverId: "drv_1",
    safetyEvents: field({ value: [], ...OBSERVED_FRESH }),
    hos: field({ value: 5, ...OBSERVED_FRESH }),
    speed: field({ value: 60, ...OBSERVED_FRESH }),
    weather: field({ value: 0.2, ...OBSERVED_FRESH }),
    zoneRisk: field({ value: 0.2, ...OBSERVED_FRESH }),
    location: field({ value: { latitude: 33.749, longitude: -84.388 }, ...OBSERVED_FRESH }),
    ...overrides,
  };
}

describe("deriveContextStatus", () => {
  test("all observed/fresh -> full_live", () => {
    assert.equal(deriveContextStatus(context()), "full_live");
  });

  test("all simulated/fresh -> demo", () => {
    const ctx = context({
      safetyEvents: field({ value: [], ...SIMULATED_FRESH }),
      hos: field({ value: 5, ...SIMULATED_FRESH }),
      speed: field({ value: 60, ...SIMULATED_FRESH }),
      weather: field({ value: 0.2, ...SIMULATED_FRESH }),
      zoneRisk: field({ value: 0.2, ...SIMULATED_FRESH }),
    });
    assert.equal(deriveContextStatus(ctx), "demo");
  });

  test("mixed observed and simulated -> partial_live", () => {
    const ctx = context({
      hos: field({ value: 5, ...SIMULATED_FALLBACK }),
      speed: field({ value: 60, ...SIMULATED_FALLBACK }),
      zoneRisk: field({ value: 0.2, ...SIMULATED_FALLBACK }),
    });
    assert.equal(deriveContextStatus(ctx), "partial_live");
  });

  test("observed/cached fields with no simulated inputs -> full_live", () => {
    const ctx = context({
      safetyEvents: field({ value: [], ...OBSERVED_CACHED }),
      weather: field({ value: 0.2, ...OBSERVED_CACHED }),
    });
    assert.equal(deriveContextStatus(ctx), "full_live");
  });

  test("a single fallback field -> partial_live", () => {
    const ctx = context({ weather: field({ value: 0.2, ...SIMULATED_FALLBACK }) });
    assert.equal(deriveContextStatus(ctx), "partial_live");
  });

  test("a single unavailable field -> partial_live", () => {
    const ctx = context({ hos: field<number>({ value: null, ...UNAVAILABLE }) });
    assert.equal(deriveContextStatus(ctx), "partial_live");
  });

  test("current pilot DriverContext shape (real events, mock hos/speed/zoneRisk) -> partial_live", () => {
    const ctx = context({
      safetyEvents: field({ value: [{ type: "harsh_braking", severity: 3 }], ...OBSERVED_FRESH }),
      hos: field({ value: 6, ...SIMULATED_FALLBACK }),
      speed: field({ value: 58, ...SIMULATED_FALLBACK }),
      zoneRisk: field({ value: 0.4, ...SIMULATED_FALLBACK }),
      weather: field({ value: 0.42, ...OBSERVED_FRESH }),
    });
    assert.equal(deriveContextStatus(ctx), "partial_live");
  });

  test("location unavailable does not affect contextStatus (Phase 1 — location isn't in the field list yet)", () => {
    const ctx = context({ location: field<{ latitude: number; longitude: number }>({ value: null, ...UNAVAILABLE }) });
    assert.equal(deriveContextStatus(ctx), "full_live");
  });

  test("current demo DriverContext shape (everything simulated/fresh) -> demo", () => {
    const ctx = context({
      safetyEvents: field({ value: [], ...SIMULATED_FRESH }),
      hos: field({ value: 3.5, ...SIMULATED_FRESH }),
      speed: field({ value: 62, ...SIMULATED_FRESH }),
      weather: field({ value: 0.1, ...SIMULATED_FRESH }),
      zoneRisk: field({ value: 0.1, ...SIMULATED_FRESH }),
    });
    assert.equal(deriveContextStatus(ctx), "demo");
  });
});

// N5 (Phase 5, 2026-08-05) — deriveDataCompleteness counts all SIX
// DriverContext fields (unlike deriveContextStatus, which only looks at
// the five RiskInput-backing fields and deliberately excludes location).
describe("deriveDataCompleteness", () => {
  test("all six fields observed/fresh -> 6 of 6", () => {
    assert.deepEqual(deriveDataCompleteness(context()), { count: 6, total: 6 });
  });

  test("total is always 6, never driver-dependent, even when every field is unavailable", () => {
    const ctx = context({
      safetyEvents: field({ ...UNAVAILABLE }),
      hos: field<number>({ ...UNAVAILABLE }),
      speed: field<number>({ ...UNAVAILABLE }),
      weather: field<number>({ ...UNAVAILABLE }),
      zoneRisk: field<number>({ ...UNAVAILABLE }),
      location: field<{ latitude: number; longitude: number }>({ ...UNAVAILABLE }),
    });
    assert.deepEqual(deriveDataCompleteness(ctx), { count: 0, total: 6 });
  });

  test("observed/cached counts as live, same as deriveContextStatus's own full_live definition", () => {
    const ctx = context({ safetyEvents: field({ value: [], ...OBSERVED_CACHED }) });
    assert.deepEqual(deriveDataCompleteness(ctx), { count: 6, total: 6 });
  });

  test("demo inputs (simulated/fresh) never count as live, even though state is 'fresh'", () => {
    const ctx = context({
      safetyEvents: field({ value: [], ...SIMULATED_FRESH }),
      hos: field({ value: 5, ...SIMULATED_FRESH }),
      speed: field({ value: 60, ...SIMULATED_FRESH }),
      weather: field({ value: 0.2, ...SIMULATED_FRESH }),
      zoneRisk: field({ value: 0.2, ...SIMULATED_FRESH }),
      location: field({ value: { latitude: 0, longitude: 0 }, ...SIMULATED_FRESH }),
    });
    assert.deepEqual(deriveDataCompleteness(ctx), { count: 0, total: 6 }, "a fully-demo DriverContext must read 0 of 6, not 6 of 6");
  });

  test("a demo account with genuinely live weather (real OpenWeatherMap success) correctly counts that one field, per its real origin", () => {
    // Mirrors assembleWeather's actual demo-branch behavior: origin becomes
    // "observed" when the real API call succeeds, even for a non-pilot
    // driver — deriveDataCompleteness must count it, same as any other
    // genuinely observed field, with no separate pilot/demo branch needed.
    const ctx = context({
      safetyEvents: field({ value: [], ...SIMULATED_FRESH }),
      hos: field({ value: 5, ...SIMULATED_FRESH }),
      speed: field({ value: 60, ...SIMULATED_FRESH }),
      weather: field({ value: 0.2, ...OBSERVED_FRESH }),
      zoneRisk: field({ value: 0.2, ...SIMULATED_FRESH }),
      location: field({ value: { latitude: 0, longitude: 0 }, ...SIMULATED_FRESH }),
    });
    assert.deepEqual(deriveDataCompleteness(ctx), { count: 1, total: 6 });
  });

  test("unavailable location alone: 5 of 6, while deriveContextStatus still reads full_live — the two are not the same denominator", () => {
    const ctx = context({ location: field<{ latitude: number; longitude: number }>({ ...UNAVAILABLE }) });
    assert.deepEqual(deriveDataCompleteness(ctx), { count: 5, total: 6 });
    assert.equal(deriveContextStatus(ctx), "full_live", "confirms location's exclusion from contextStatus, unaffected by this change");
  });

  test("fallback fields (pilot, not-yet-integrated) do not count as live", () => {
    const ctx = context({
      hos: field({ value: 5, ...SIMULATED_FALLBACK }),
      speed: field({ value: 60, ...SIMULATED_FALLBACK }),
      zoneRisk: field({ value: 0.2, ...SIMULATED_FALLBACK }),
    });
    assert.deepEqual(deriveDataCompleteness(ctx), { count: 3, total: 6 });
  });

  test("current real pilot DriverContext shape (real events, mock hos/speed/zoneRisk, real weather/location) -> 3 of 6", () => {
    const ctx = context({
      safetyEvents: field({ value: [{ type: "harsh_braking", severity: 3 }], ...OBSERVED_FRESH }),
      hos: field({ value: 6, ...SIMULATED_FALLBACK }),
      speed: field({ value: 58, ...SIMULATED_FALLBACK }),
      zoneRisk: field({ value: 0.4, ...SIMULATED_FALLBACK }),
      weather: field({ value: 0.42, ...OBSERVED_FRESH }),
      location: field({ value: { latitude: 33.7, longitude: -84.4 }, ...OBSERVED_FRESH }),
    });
    assert.deepEqual(deriveDataCompleteness(ctx), { count: 3, total: 6 });
  });

  test("weighting is never applied — a single unavailable field always costs exactly 1, regardless of which field it is", () => {
    const missingWeather = deriveDataCompleteness(context({ weather: field<number>({ ...UNAVAILABLE }) }));
    const missingSafetyEvents = deriveDataCompleteness(context({ safetyEvents: field({ ...UNAVAILABLE }) }));
    assert.deepEqual(missingWeather, { count: 5, total: 6 });
    assert.deepEqual(missingSafetyEvents, { count: 5, total: 6 });
    assert.deepEqual(missingWeather, missingSafetyEvents, "every field contributes equally to the count — no per-field weighting");
  });
});

describe("toContextSources", () => {
  test("strips value, keeps origin/state/provider/observedAt", () => {
    const ctx = context();
    const sources = toContextSources(ctx);
    assert.deepEqual(sources.hos, { origin: "observed", state: "fresh", provider: "samsara", observedAt: "2026-07-13T00:00:00.000Z" });
    assert.equal((sources.hos as any).value, undefined);
  });
});

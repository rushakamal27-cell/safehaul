import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveContextStatus } from "../contextStatus";
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

describe("toContextSources", () => {
  test("strips value, keeps origin/state/provider/observedAt", () => {
    const ctx = context();
    const sources = toContextSources(ctx);
    assert.deepEqual(sources.hos, { origin: "observed", state: "fresh", provider: "samsara", observedAt: "2026-07-13T00:00:00.000Z" });
    assert.equal((sources.hos as any).value, undefined);
  });
});

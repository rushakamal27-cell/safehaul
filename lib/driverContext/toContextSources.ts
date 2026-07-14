/**
 * lib/driverContext/toContextSources.ts
 *
 * Pure transformation from DriverContext to ContextSources — the same
 * per-field provenance metadata, with `value` stripped. This is what /api/risk
 * exposes publicly: consumers get "how was this sourced" without a second,
 * redundant copy of the numbers already in `input`.
 */

import type { ContextSourceMeta, ContextSources, DriverContext, DriverContextField } from "./types";

function toMeta<T>(field: DriverContextField<T>): ContextSourceMeta {
  return {
    origin: field.origin,
    state: field.state,
    provider: field.provider,
    observedAt: field.observedAt,
  };
}

export function toContextSources(context: DriverContext): ContextSources {
  return {
    safetyEvents: toMeta(context.safetyEvents),
    hos: toMeta(context.hos),
    speed: toMeta(context.speed),
    weather: toMeta(context.weather),
    zoneRisk: toMeta(context.zoneRisk),
  };
}

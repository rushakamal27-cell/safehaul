/**
 * lib/driverContext/contextStatus.ts
 *
 * Derives a backend-owned ContextStatus summary from DriverContext. This is
 * intentionally computed from field-level provenance, not from `dataSource`
 * (which only reflects pilot/non-pilot connection status) — a pilot driver
 * with real safety events but mock HOS/speed/zoneRisk is "partial_live",
 * even though dataSource says "real".
 *
 * Rules (evaluated over all five RiskInput-backing fields):
 *   full_live    — every field has origin "observed" or "estimated", and
 *                   none has state "fallback" or "unavailable".
 *   demo         — every field has origin "simulated" and state "fresh".
 *   partial_live — anything else, including today's pilot drivers (real
 *                  safety events, still-mock HOS/speed/zoneRisk).
 *
 * Also home to deriveDataCompleteness (N5, Phase 5, 2026-08-05) — a
 * separate, simpler summary of the SAME per-field provenance, described
 * below.
 */

import type { ContextStatus, DriverContext, DriverContextField } from "./types";

function isLive(field: DriverContextField<unknown>): boolean {
  return (
    (field.origin === "observed" || field.origin === "estimated") &&
    field.state !== "fallback" &&
    field.state !== "unavailable"
  );
}

function isDemo(field: DriverContextField<unknown>): boolean {
  return field.origin === "simulated" && field.state === "fresh";
}

export function deriveContextStatus(context: DriverContext): ContextStatus {
  const fields: DriverContextField<unknown>[] = [
    context.safetyEvents,
    context.hos,
    context.speed,
    context.weather,
    context.zoneRisk,
  ];

  if (fields.every(isDemo)) return "demo";
  if (fields.every(isLive)) return "full_live";
  return "partial_live";
}

/**
 * Plain count/total of how many of DriverContext's six tracked fields are
 * currently live — deliberately NOT a confidence, prediction-confidence,
 * accuracy, reliability, or certainty measure (N5, Phase 5, 2026-08-05).
 * It answers "how much of our tracked input is real right now," not "how
 * much should you trust this score" — the latter would require labeled
 * real-world outcomes to validate against, which don't exist yet (see the
 * Phase 5 audit's Item 5 finding). Never weighted by how much a field
 * would change the score if it went live — every field counts exactly 1,
 * regardless of its penalty magnitude.
 *
 * The six fields counted: safetyEvents, hos, speed, weather, zoneRisk,
 * location. This is ALL SIX of DriverContext's DriverContextField members
 * — not just the five deriveContextStatus/RiskInput use. `location` is
 * included even though it does not feed RiskInput and is deliberately
 * excluded from deriveContextStatus's full_live/partial_live computation
 * (see that function's comment and DriverContext.location's own comment in
 * ./types.ts) — it is still a genuine, separately-tracked live/demo/
 * unavailable signal with its own real provenance, and is the upstream
 * gate for weather/zoneRisk/speed's own liveness (see assemble.ts: those
 * three only attempt a real reading when location.state is "fresh"), so
 * it's a meaningful 6th signal even though it doesn't itself carry
 * scoring weight.
 *
 * IMPORTANT — this means deriveDataCompleteness's total (6) and
 * deriveContextStatus's field set (5) are NOT the same set. A driver can
 * legitimately show contextStatus "full_live" (all 5 scoring inputs live)
 * while deriveDataCompleteness reads "5 of 6" (only location itself is
 * currently unavailable) — this is not a bug or a contradiction between
 * the two functions; it means the score's own inputs are all live, but a
 * 6th tracked-but-non-scoring signal (current position) isn't available
 * this call. UI copy showing both must not imply they're the same
 * denominator.
 *
 * Uses the exact same isLive() predicate deriveContextStatus uses (fresh
 * OR cached both count — "real data" doesn't require reconfirmation this
 * exact call to count as live, matching full_live's own definition) so the
 * two functions can never silently disagree about whether a given field is
 * "live." A field with origin "simulated" (demo data — including a demo
 * account's weather when it happens to be genuinely live via
 * OPENWEATHER_API_KEY, which correctly counts here since its origin is
 * "observed" for that call) never counts, with no separate demo check
 * needed — isLive()'s own origin requirement already excludes every
 * simulated/demo field, unconditionally.
 *
 * Never weighted, never partial-credit: each of the six fields contributes
 * exactly 0 or 1 to `count`. `total` is always 6, not driver-dependent.
 */
export function deriveDataCompleteness(context: DriverContext): { count: number; total: number } {
  const fields: DriverContextField<unknown>[] = [
    context.safetyEvents,
    context.hos,
    context.speed,
    context.weather,
    context.zoneRisk,
    context.location,
  ];

  return {
    count: fields.filter(isLive).length,
    total: fields.length,
  };
}

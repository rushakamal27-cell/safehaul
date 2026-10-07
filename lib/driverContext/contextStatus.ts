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

import type { ContextSourceMeta, ContextSources, ContextStatus, DriverContext } from "./types";
import { toContextSources } from "./toContextSources";

/**
 * Liveness is decided purely from provenance (origin + state) — never from
 * the value — which is what lets the *-FromSources variants below classify a
 * historical SafetyScoreSample from its persisted breakdownJson.contextSources
 * using the exact same rule as a live context. Exported so
 * lib/dataQuality/historicalSamples.ts cannot drift from this definition.
 */
export function isLiveProvenance(meta: ContextSourceMeta): boolean {
  return (
    (meta.origin === "observed" || meta.origin === "estimated") &&
    meta.state !== "fallback" &&
    meta.state !== "unavailable"
  );
}

export function isDemoProvenance(meta: ContextSourceMeta): boolean {
  return meta.origin === "simulated" && meta.state === "fresh";
}

/**
 * The three scoring inputs that only ever go live when the vehicle's own
 * position did (see assemble.ts: weather/zoneRisk/speed are each gated on
 * location.state === "fresh"). If none of them is live, the risk engine saw
 * no situational evidence at all and `toRiskInput`'s neutral 0 defaults are
 * the only thing standing in for conditions — which produces a benign,
 * unearned score. Deliberately excludes `hos` (unavailable fleet-wide) and
 * `safetyEvents` (an observed-but-empty list is a legitimate fact, but on its
 * own it cannot justify a score).
 */
function hasNoLivePositionalInput(sources: ContextSources): boolean {
  return [sources.speed, sources.weather, sources.zoneRisk].every((m) => !isLiveProvenance(m));
}

/**
 * The single classification waterfall. Operates on provenance only, so it is
 * identical for a live context and for a historical row's persisted
 * contextSources — see lib/dataQuality/historicalSamples.ts.
 */
export function deriveContextStatusFromSources(sources: ContextSources): ContextStatus {
  const scoringFields: ContextSourceMeta[] = [
    sources.safetyEvents,
    sources.hos,
    sources.speed,
    sources.weather,
    sources.zoneRisk,
  ];

  // demo is checked first on purpose: a demo driver's fields are all
  // origin "simulated", which isLiveProvenance() rejects, so they would
  // otherwise be misreported as insufficient_context.
  if (scoringFields.every(isDemoProvenance)) return "demo";
  if (scoringFields.every(isLiveProvenance)) return "full_live";
  // UNKNOWN ≠ SAFE (Phase 6D closure): mark the hour unusable rather than
  // letting an empty context pass as an ordinary partial_live score.
  if (hasNoLivePositionalInput(sources)) return "insufficient_context";
  return "partial_live";
}

export function deriveContextStatus(context: DriverContext): ContextStatus {
  return deriveContextStatusFromSources(toContextSources(context));
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
export function deriveDataCompletenessFromSources(
  sources: ContextSources
): { count: number; total: number } {
  const fields: ContextSourceMeta[] = [
    sources.safetyEvents,
    sources.hos,
    sources.speed,
    sources.weather,
    sources.zoneRisk,
    sources.location,
  ];

  return {
    count: fields.filter(isLiveProvenance).length,
    total: fields.length,
  };
}

export function deriveDataCompleteness(context: DriverContext): { count: number; total: number } {
  return deriveDataCompletenessFromSources(toContextSources(context));
}

/**
 * lib/driverContext/toRiskInput.ts
 *
 * Pure transformation from DriverContext to the RiskInput shape consumed by
 * lib/riskEngine.ts. Most unavailable fields default to neutral
 * (non-penalizing) values rather than blocking scoring — every current
 * penalty function is "more input = more penalty," so 0 is a default that
 * can't fabricate a penalty from a data gap.
 *
 * hos is the one exception: it passes through null unchanged instead of
 * defaulting to 0. A missing HOS reading is not the same fact as "0 hours
 * used," and calcFatiguePenalty/buildRecommendations in lib/riskEngine.ts
 * are null-aware specifically so this doesn't need a fabricated default.
 *
 * calculateRisk() never imports lib/driverContext — this function is the
 * only seam allowed to see both types, so DriverContextField metadata can't
 * leak into the risk engine.
 *
 * weatherAvailable/zoneRiskAvailable/hosAvailable (Phase 4.5 — Contextual
 * Speed) are the one exception to "never leak DriverContextField metadata":
 * they carry only a plain boolean (not origin/state/provider/observedAt) so
 * the contextual speed multiplier in lib/riskEngine.ts can tell "real data
 * defaulted to a neutral 0/null" apart from "a genuine 0/null reading" —
 * without amplifying a pilot's speed penalty on a data gap it can't see.
 * Equivalent to `value !== null` on the corresponding field — the same test
 * hosHours already relies on above, just also applied to weather/zoneRisk.
 */

import type { RiskInput } from "@/lib/riskEngine";
import type { DriverContext } from "./types";

export function toRiskInput(context: DriverContext): RiskInput {
  return {
    safetyEvents: context.safetyEvents.value ?? [],
    hosHours: context.hos.value,
    weatherRisk: context.weather.value ?? 0,
    zoneRisk: context.zoneRisk.value ?? 0,
    speed: context.speed.value ?? 0,
    weatherAvailable: context.weather.value !== null,
    zoneRiskAvailable: context.zoneRisk.value !== null,
    hosAvailable: context.hos.value !== null,
  };
}

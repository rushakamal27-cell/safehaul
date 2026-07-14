/**
 * lib/driverContext/toRiskInput.ts
 *
 * Pure transformation from DriverContext to the RiskInput shape consumed by
 * lib/riskEngine.ts. Unavailable fields default to neutral (non-penalizing)
 * values rather than blocking scoring — every current penalty function is
 * "more input = more penalty," so 0 is the one default that can't fabricate
 * a penalty from a data gap. calculateRisk() never imports lib/driverContext
 * — this function is the only seam allowed to see both types, so
 * DriverContextField metadata can't leak into the risk engine.
 */

import type { RiskInput } from "@/lib/riskEngine";
import type { DriverContext } from "./types";

export function toRiskInput(context: DriverContext): RiskInput {
  return {
    safetyEvents: context.safetyEvents.value ?? [],
    hosHours: context.hos.value ?? 0,
    weatherRisk: context.weather.value ?? 0,
    zoneRisk: context.zoneRisk.value ?? 0,
    speed: context.speed.value ?? 0,
  };
}

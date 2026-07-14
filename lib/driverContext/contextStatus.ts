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

/**
 * lib/location.ts
 *
 * Operational context layer for SafeHaul — backs app/api/location.
 *
 * Two paths, matching the trust rules already established for DriverContext
 * (lib/driverContext/assemble.ts):
 *   - getMockDriverLocation: non-pilot/demo drivers — unchanged, fully
 *     scenario-driven via lib/samsara.ts.
 *   - getPilotDriverLocation (Phase 2): pilot drivers — reuses
 *     lib/driverContext/assemble.ts's assembleLocation directly rather than
 *     duplicating vehicle-ID resolution / GPS-fetch / freshness logic here.
 *     lat/lng/locationLabel are real-or-null, never a mock scenario
 *     coordinate — fresh/stale/unavailable `state` matches /api/risk's
 *     location semantics exactly, by construction (same function).
 *
 * zoneName/zoneRisk/currentSpeed/heading/weatherRisk are explicitly out of
 * scope for pilots in this phase (real zone risk and real speed scoring are
 * separate, not-yet-started phases; weather is assembled by DriverContext,
 * not duplicated here) — they are null for a pilot rather than a fabricated
 * mock value smuggled in next to genuinely real fields. checksPassed/
 * milesDriven ARE already real for pilots (lib/todaySummary.ts), so those
 * are included as-is — reusing an existing real source, not new assembly.
 */

import { getDriverVehicleContext, getDriverDailySummary } from "@/lib/samsara";
import { fetchTodaySummaryData } from "@/lib/todaySummary";
import { assembleLocation } from "@/lib/driverContext/assemble";
import type { LocationState } from "@/lib/driverContext/types";

export type CardinalHeading = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

export interface DriverLocation {
  driverId: string;
  lat: number | null;
  lng: number | null;
  locationLabel: string | null;   // Human-readable current location
  zoneName: string | null;        // Named operational zone if active, else empty string (demo) or null (pilot, out of scope)
  zoneRisk: number | null;        // Normalized 0–1 zone risk score; null for pilots (out of scope this phase)
  currentSpeed: number | null;    // mph; null for pilots (real speed scoring out of scope this phase)
  heading: CardinalHeading | null;
  weatherRisk: number | null;     // Normalized 0–1 weather risk score; null when pilot weather is unavailable
  checksPassed: number;           // Daily pre-trip / roadside inspection checks passed
  milesDriven: number | null;     // Miles driven today
  updatedAt: string;              // ISO 8601 timestamp — when this response was built
  /** Trust provenance for lat/lng/locationLabel — "observed" (pilot, real GPS attempt) or "simulated" (demo, mock scenario). Never absent. */
  origin: "observed" | "simulated";
  /** Matches /api/risk's location.state exactly for pilots (same assembleLocation call); "fresh" for demo (intentional, not a gap). */
  state: LocationState;
}

export async function getMockDriverLocation(driverId: string): Promise<DriverLocation> {
  const [vehicle, daily] = await Promise.all([
    getDriverVehicleContext(driverId),
    getDriverDailySummary(driverId),
  ]);

  return {
    driverId,
    lat:           vehicle.lat,
    lng:           vehicle.lng,
    locationLabel: vehicle.locationLabel,
    zoneName:      vehicle.zoneName,
    zoneRisk:      vehicle.zoneRisk,
    currentSpeed:  vehicle.currentSpeed,
    heading:       "W",  // TODO: derive from consecutive GPS readings
    weatherRisk:   vehicle.weatherRisk,
    checksPassed:  daily.checksPassed,
    milesDriven:   daily.milesDriven,
    updatedAt:     new Date().toISOString(),
    origin:        "simulated",
    state:         "fresh",
  };
}

/**
 * Pilot path — reuses assembleLocation verbatim (no duplicated Samsara/
 * freshness logic). lat/lng/locationLabel are null whenever
 * assembleLocation's state is "unavailable"; they're still populated (real)
 * for "stale", for the same transparency reason DriverContext.location
 * preserves stale coordinates rather than hiding them.
 */
export async function getPilotDriverLocation(driverId: string): Promise<DriverLocation> {
  const now = new Date().toISOString();
  const [{ detail }, summary] = await Promise.all([
    assembleLocation(driverId, true, now),
    fetchTodaySummaryData(driverId, true),
  ]);

  return {
    driverId,
    lat:           detail.latitude,
    lng:           detail.longitude,
    locationLabel: detail.formattedLocation ?? null,
    zoneName:      null,
    zoneRisk:      null,
    currentSpeed:  null,
    heading:       null,
    weatherRisk:   null,
    checksPassed:  summary.checksPassed,
    milesDriven:   summary.milesDriven,
    updatedAt:     now,
    origin:        "observed",
    state:         detail.state,
  };
}

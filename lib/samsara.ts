/**
 * lib/samsara.ts
 *
 * Samsara data provider for SafeHaul.
 *
 * Provider mode is controlled by SAMSARA_API_KEY in your environment:
 *   - Absent (default): scenario-based mock data from lib/mockScenarios.ts
 *   - Present: replace each mock function body with the real Samsara API call
 *     indicated by the SWAP-IN comment. Function signatures stay identical.
 *
 * Public API — stable across mock and real modes:
 *   getRiskInputForDriver(driverId)    → RiskInput      (no longer used by /api/risk — see
 *                                         lib/driverContext/assemble.ts + toRiskInput.ts for
 *                                         the current path; retained as a standalone
 *                                         convenience wrapper)
 *   getDriverDailySummary(driverId)    → DriverDailySummary (consumed by lib/location.ts)
 *   getDriverVehicleContext(driverId)  → DriverVehicleContext (consumed by lib/location.ts)
 *
 * Per-field getters (getMockDriverHos, getMockVehicleStats, getMockSafetyEvents,
 * getMockZoneRisk) are also exported for lib/driverContext/assemble.ts, which
 * needs each field individually to attach provenance metadata.
 *
 * getWeatherRiskField (Phase 2 — Weather from Real Vehicle GPS) takes explicit
 * coordinates, not a MockScenario — it has no concept of mock/pilot at all.
 * lib/driverContext/assemble.ts decides which coordinates to pass (real GPS
 * for a pilot with fresh location, scenario coordinates for demo) and what a
 * null result means in each case.
 *
 * getMockTripStats is exported for lib/todaySummary.ts's non-pilot/demo mileage path.
 */

import { RiskInput } from "@/lib/riskEngine";
import { getScenarioForDriver, MockScenario } from "@/lib/mockScenarios";

// ---------------------------------------------------------------------------
// Samsara data types — mirror real Samsara API response shapes
// ---------------------------------------------------------------------------

export interface SamsaraDriver {
  id: string;
  name: string;
  hosHoursUsed: number; // hours on duty in current cycle
}

export interface SamsaraVehicleStats {
  currentSpeed: number; // mph
  lat: number;
  lng: number;
}

export interface SamsaraSafetyEvent {
  type: string;      // e.g. "harsh_braking" | "speeding"
  severity: number;  // 1–5
  timestamp: string; // ISO 8601
}

export interface SamsaraTripStats {
  milesDrivenToday: number;
}

export interface SamsaraInspectionSummary {
  checksPassed: number; // daily DVIRs with no defects
}

// ---------------------------------------------------------------------------
// Mock implementations — each reads from the active scenario.
// To switch to real Samsara: replace the function body with the API call
// shown in the SWAP-IN comment. The scenario argument disappears; use driverId.
// ---------------------------------------------------------------------------

export function getMockDriverHos(scenario: MockScenario): SamsaraDriver {
  // SWAP-IN: GET https://api.samsara.com/fleet/drivers/{driverId}/hos-logs
  return { id: scenario.label, name: "Mock Driver", hosHoursUsed: scenario.hosHoursUsed };
}

export function getMockVehicleStats(scenario: MockScenario): SamsaraVehicleStats {
  // SWAP-IN: GET https://api.samsara.com/fleet/vehicles/stats?driverIds={driverId}
  return { currentSpeed: scenario.currentSpeed, lat: scenario.lat, lng: scenario.lng };
}

export function getMockSafetyEvents(scenario: MockScenario): SamsaraSafetyEvent[] {
  // SWAP-IN: GET https://api.samsara.com/fleet/safety-events?driverIds={driverId}
  return scenario.safetyEvents.map(e => ({ ...e }));
}

/**
 * Converts an OpenWeatherMap /data/2.5/weather response to a normalized 0–1 risk value.
 * Factors: weather condition code, wind speed, and visibility.
 */
function weatherDataToRisk(data: any): number {
  const conditionId  = data.weather?.[0]?.id  ?? 800;  // 800 = clear sky
  const windSpeed    = data.wind?.speed        ?? 0;    // m/s
  const visibility   = data.visibility         ?? 10000; // metres, max 10 000

  let risk = 0;

  // Condition code bands (WMO / OpenWeatherMap classification)
  if      (conditionId < 300) risk += 0.50; // 2xx thunderstorm
  else if (conditionId < 400) risk += 0.20; // 3xx drizzle
  else if (conditionId < 600) risk += 0.35; // 5xx rain
  else if (conditionId < 700) risk += 0.45; // 6xx snow / sleet
  else if (conditionId < 800) risk += 0.30; // 7xx atmosphere (fog, haze, dust)
  else if (conditionId > 800) risk += 0.05; // 80x–80x clouds

  // Wind speed — caps out at 0.30 above 20 m/s (~45 mph)
  risk += Math.min(windSpeed / 20, 0.30);

  // Poor visibility — caps out at 0.20 below 500 m
  risk += Math.max(0, (10000 - visibility) / 10000) * 0.20;

  return Math.min(1, Math.round(risk * 100) / 100);
}

export interface RealWeatherResult {
  weatherRisk: number;
  /** ISO 8601 UTC, converted from OpenWeatherMap's own `dt` field — never the request time. Always present when this object exists; see parseWeatherResponse. */
  observedAt: string;
  /** Human-readable condition, e.g. "clear sky" — from weather[0].description, when present. */
  conditionSummary: string | null;
}

/** Precision (decimal places) coordinates are rounded to before building the OpenWeatherMap request URL — see roundWeatherCoordinate for the tradeoff. */
export const WEATHER_COORDINATE_PRECISION = 2;

/**
 * Pure — rounds a coordinate to WEATHER_COORDINATE_PRECISION before it
 * becomes part of the OpenWeatherMap request URL (and therefore the
 * Next.js fetch cache key). Raw Samsara GPS precision (~6 decimals, ~11cm)
 * would make every single reading its own unique cache key even for a
 * stationary truck, defeating the 5-minute revalidate window entirely.
 * 2 decimal places (~1.1km at the equator) is coarse enough for effective
 * caching — weather doesn't meaningfully vary over that distance — while
 * still far too fine to place a truck in a different weather system.
 * Applied only to the outgoing request URL; DriverContext.location and
 * VehicleLocation keep full raw precision for display/audit purposes.
 */
export function roundWeatherCoordinate(value: number): number {
  const factor = 10 ** WEATHER_COORDINATE_PRECISION;
  return Math.round(value * factor) / factor;
}

/**
 * Pure — parses one OpenWeatherMap /data/2.5/weather response. Returns null
 * (never a fabricated timestamp) when `dt` — the provider's own observation
 * time — is missing or not a finite number, per the same "don't invent it"
 * rule as every other real-data path in this codebase.
 */
export function parseWeatherResponse(data: any): RealWeatherResult | null {
  const dt = data?.dt;
  if (typeof dt !== "number" || !isFinite(dt)) return null;

  const description = data?.weather?.[0]?.description;
  return {
    weatherRisk: weatherDataToRisk(data),
    observedAt: new Date(dt * 1000).toISOString(),
    conditionSummary: typeof description === "string" ? description : null,
  };
}

export interface WeatherCoordinates {
  latitude: number;
  longitude: number;
  signal?: AbortSignal;
}

/**
 * Fetches real weather risk from OpenWeatherMap for explicit coordinates.
 * Provider-only: no MockScenario, no pilot/non-pilot awareness — those
 * decisions belong to lib/driverContext/assemble.ts, the only place that
 * knows whether "no real weather" should mean "fall back to a simulated
 * value" (demo) or "unavailable" (pilot). Returns null on a missing API
 * key, a failed/non-200 request, an unparseable body, or a missing/invalid
 * provider observation timestamp — callers decide what null means to them.
 */
export async function getWeatherRiskField(params: WeatherCoordinates): Promise<RealWeatherResult | null> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return null;

  const lat = roundWeatherCoordinate(params.latitude);
  const lon = roundWeatherCoordinate(params.longitude);

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}`;
    const res = await fetch(url, { next: { revalidate: 300 }, signal: params.signal }); // cache 5 min
    if (!res.ok) return null;
    return parseWeatherResponse(await res.json());
  } catch {
    return null;
  }
}

/**
 * Returns a 0–1 weather risk value for a mock scenario's coordinates.
 * Uses real OpenWeatherMap data when OPENWEATHER_API_KEY is set and the
 * call succeeds; falls back to the scenario's own mock value otherwise.
 * Scenario-only convenience wrapper — see getWeatherRiskField for the
 * coordinate-based provider call this is built on.
 */
async function getWeatherRisk(scenario: MockScenario): Promise<number> {
  const result = await getWeatherRiskField({ latitude: scenario.lat, longitude: scenario.lng });
  return result?.weatherRisk ?? scenario.weatherRisk;
}

export function getMockZoneRisk(scenario: MockScenario): number {
  // SWAP-IN: query internal geo-fencing service keyed on scenario.lat / scenario.lng
  return scenario.zoneRisk;
}

export function getMockTripStats(scenario: MockScenario): SamsaraTripStats {
  // SWAP-IN: GET https://api.samsara.com/fleet/trips?driverIds={driverId}&startTime={today_midnight_utc}
  return { milesDrivenToday: scenario.milesDrivenToday };
}

function getMockInspectionSummary(scenario: MockScenario): SamsaraInspectionSummary {
  // SWAP-IN: GET https://api.samsara.com/fleet/vehicles/dvirs?driverIds={driverId}&endTime={now}
  //          Count responses where defects.length === 0
  return { checksPassed: scenario.checksPassed };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export interface DriverDailySummary {
  milesDriven: number;
  checksPassed: number;
}

export interface DriverVehicleContext {
  lat: number;
  lng: number;
  currentSpeed: number;    // mph
  locationLabel: string;   // human-readable location string
  zoneName: string;        // named operational zone, empty string if none
  weatherRisk: number;     // 0–1, sourced from weather provider
  zoneRisk: number;        // 0–1, sourced from geo-fencing service
}

/** Assembles Samsara inputs for the risk engine. */
export async function getRiskInputForDriver(driverId: string): Promise<RiskInput> {
  const scenario     = getScenarioForDriver(driverId);
  const driver       = getMockDriverHos(scenario);
  const vehicle      = getMockVehicleStats(scenario);
  const safetyEvents = getMockSafetyEvents(scenario);
  const weatherRisk  = await getWeatherRisk(scenario);
  const zoneRisk     = getMockZoneRisk(scenario);

  return {
    safetyEvents: safetyEvents.map(({ type, severity }) => ({ type, severity })),
    hosHours:     driver.hosHoursUsed,
    weatherRisk,
    zoneRisk,
    speed:        vehicle.currentSpeed,
  };
}

/** Assembles daily trip and inspection summary for the Dashboard stats. */
export async function getDriverDailySummary(driverId: string): Promise<DriverDailySummary> {
  const scenario    = getScenarioForDriver(driverId);
  const trip        = getMockTripStats(scenario);
  const inspections = getMockInspectionSummary(scenario);
  return {
    milesDriven:  trip.milesDrivenToday,
    checksPassed: inspections.checksPassed,
  };
}

/** Assembles vehicle position and location context for lib/location.ts. */
export async function getDriverVehicleContext(driverId: string): Promise<DriverVehicleContext> {
  const scenario = getScenarioForDriver(driverId);
  const vehicle  = getMockVehicleStats(scenario);
  return {
    lat:           vehicle.lat,
    lng:           vehicle.lng,
    currentSpeed:  vehicle.currentSpeed,
    locationLabel: scenario.locationLabel,
    zoneName:      scenario.zoneName,
    weatherRisk:   await getWeatherRisk(scenario),
    zoneRisk:      getMockZoneRisk(scenario),
  };
}

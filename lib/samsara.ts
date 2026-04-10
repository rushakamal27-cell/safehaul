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
 *   getRiskInputForDriver(driverId)    → RiskInput      (consumed by /api/risk)
 *   getDriverDailySummary(driverId)    → DriverDailySummary (consumed by lib/location.ts)
 *   getDriverVehicleContext(driverId)  → DriverVehicleContext (consumed by lib/location.ts)
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

function getMockDriverHos(scenario: MockScenario): SamsaraDriver {
  // SWAP-IN: GET https://api.samsara.com/fleet/drivers/{driverId}/hos-logs
  return { id: scenario.label, name: "Mock Driver", hosHoursUsed: scenario.hosHoursUsed };
}

function getMockVehicleStats(scenario: MockScenario): SamsaraVehicleStats {
  // SWAP-IN: GET https://api.samsara.com/fleet/vehicles/stats?driverIds={driverId}
  return { currentSpeed: scenario.currentSpeed, lat: scenario.lat, lng: scenario.lng };
}

function getMockSafetyEvents(scenario: MockScenario): SamsaraSafetyEvent[] {
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

/**
 * Returns a 0–1 weather risk value.
 * Uses real OpenWeatherMap data when OPENWEATHER_API_KEY is set;
 * falls back to the scenario's mock value on missing key, API error, or network failure.
 */
async function getWeatherRisk(scenario: MockScenario): Promise<number> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    console.log("[getWeatherRisk] no key → scenario fallback:", scenario.weatherRisk);
    return scenario.weatherRisk;
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${scenario.lat}&lon=${scenario.lng}&appid=${apiKey}`;
    const res = await fetch(url, { next: { revalidate: 300 } }); // cache 5 min
    if (!res.ok) {
      console.log("[getWeatherRisk] API error", res.status, "→ scenario fallback:", scenario.weatherRisk);
      return scenario.weatherRisk;
    }
    const risk = weatherDataToRisk(await res.json());
    console.log("[getWeatherRisk] live OpenWeather →", risk, "(scenario was:", scenario.weatherRisk, ")");
    return risk;
  } catch (err) {
    console.log("[getWeatherRisk] fetch failed →", err, "→ scenario fallback:", scenario.weatherRisk);
    return scenario.weatherRisk;
  }
}

function getMockZoneRisk(scenario: MockScenario): number {
  // SWAP-IN: query internal geo-fencing service keyed on scenario.lat / scenario.lng
  return scenario.zoneRisk;
}

function getMockTripStats(scenario: MockScenario): SamsaraTripStats {
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

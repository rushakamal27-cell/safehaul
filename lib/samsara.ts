/**
 * lib/samsara.ts
 *
 * Mock Samsara integration layer.
 * Each function mirrors the shape of a real Samsara API call scoped to a driverId.
 * To switch to live data: replace the internals of each function — signatures stay identical.
 */

import { RiskInput } from "@/lib/riskEngine";

// ---------------------------------------------------------------------------
// Samsara data types (mirror real Samsara API response shapes)
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
  type: string;     // e.g. "harsh_braking", "speeding"
  severity: number; // 1–5
  timestamp: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Mock data functions — one per Samsara resource, scoped by driverId
// ---------------------------------------------------------------------------

function getMockDriverHos(driverId: string): SamsaraDriver {
  // TODO: GET https://api.samsara.com/fleet/drivers/{id}/hos-logs
  return {
    id: driverId,
    name: "Mock Driver",
    hosHoursUsed: 9.5,
  };
}

function getMockVehicleStats(driverId: string): SamsaraVehicleStats {
  // TODO: GET https://api.samsara.com/fleet/vehicles/stats?driverIds={id}
  return {
    currentSpeed: 74,
    lat: 32.0835,
    lng: -81.0998, // Port of Savannah area
  };
}

function getMockSafetyEvents(driverId: string): SamsaraSafetyEvent[] {
  // TODO: GET https://api.samsara.com/fleet/safety-events?driverIds={id}
  return [
    { type: "speeding",      severity: 3, timestamp: new Date().toISOString() },
    { type: "harsh_braking", severity: 2, timestamp: new Date().toISOString() },
  ];
}

function getMockWeatherRisk(lat: number, lng: number): number {
  // TODO: integrate weather API (e.g. OpenWeatherMap) keyed on lat/lng
  // Returns normalized 0–1 risk value
  return 0.6;
}

function getMockZoneRisk(lat: number, lng: number): number {
  // TODO: query internal zone risk table or geo-fencing service keyed on lat/lng
  // Returns normalized 0–1 risk value
  return 0.4;
}

// ---------------------------------------------------------------------------
// Public export — assembles all Samsara data into a RiskInput
// ---------------------------------------------------------------------------

export async function getRiskInputForDriver(driverId: string): Promise<RiskInput> {
  // Each call below will become an async fetch when the real Samsara API is wired in
  const driver       = getMockDriverHos(driverId);
  const vehicle      = getMockVehicleStats(driverId);
  const safetyEvents = getMockSafetyEvents(driverId);
  const weatherRisk  = getMockWeatherRisk(vehicle.lat, vehicle.lng);
  const zoneRisk     = getMockZoneRisk(vehicle.lat, vehicle.lng);

  return {
    safetyEvents: safetyEvents.map(({ type, severity }) => ({ type, severity })),
    hosHours:     driver.hosHoursUsed,
    weatherRisk,
    zoneRisk,
    speed:        vehicle.currentSpeed,
  };
}

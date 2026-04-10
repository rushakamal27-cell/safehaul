/**
 * lib/location.ts
 *
 * Operational context layer for SafeHaul.
 * Assembles enriched driver context from provider-layer sources in lib/samsara.ts.
 *
 * All fields are sourced from getDriverVehicleContext and getDriverDailySummary.
 * When those functions are backed by real Samsara data, this layer requires no changes.
 *
 * Remaining mock fields (sourced from scenario data in lib/mockScenarios.ts):
 *   - heading → TODO: derive from consecutive GPS readings or Samsara heading field
 *   - weatherRisk and zoneRisk are scenario-driven via samsara.ts; swap-in real providers there
 */

import { getDriverVehicleContext, getDriverDailySummary } from "@/lib/samsara";

export type CardinalHeading = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

export interface DriverLocation {
  driverId: string;
  lat: number;
  lng: number;
  locationLabel: string;   // Human-readable current location
  zoneName: string;        // Named operational zone if active, else empty string
  zoneRisk: number;        // Normalized 0–1 zone risk score
  currentSpeed: number;    // mph
  heading: CardinalHeading;
  weatherRisk: number;     // Normalized 0–1 weather risk score
  checksPassed: number;    // Daily pre-trip / roadside inspection checks passed
  milesDriven: number;     // Miles driven today
  updatedAt: string;       // ISO 8601 timestamp
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
  };
}

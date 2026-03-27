/**
 * lib/location.ts
 *
 * Mock location and operational context layer for SafeHaul.
 * Provides enriched driver context beyond raw vehicle stats:
 * zone names, human-readable labels, heading, and combined risk signals.
 *
 * TODO: Replace getMockDriverLocation internals with:
 *   - SamsaraVehicleStats for lat, lng, currentSpeed (lib/samsara.ts)
 *   - Internal geo-fencing service for zoneName, zoneRisk
 *   - Weather API (e.g. OpenWeatherMap) for weatherRisk
 *   - Reverse-geocoding API for locationLabel
 */

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
  updatedAt: string;       // ISO 8601 timestamp
}

export function getMockDriverLocation(driverId: string): DriverLocation {
  // TODO: replace each field with a live data source (see file header)
  return {
    driverId,
    lat: 32.0835,
    lng: -81.0998,
    locationLabel: "I-16 W · Mile Marker 52, Chatham County, GA",
    zoneName: "Port of Savannah — Terminal Gate 7",
    zoneRisk: 0.4,
    currentSpeed: 74,
    heading: "W",
    weatherRisk: 0.6,
    updatedAt: new Date().toISOString(),
  };
}

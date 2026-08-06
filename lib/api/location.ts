/**
 * lib/api/location.ts
 *
 * The true response contract for GET /api/location (N4, Phase 5,
 * 2026-08-05). Both lib/location.ts (server — backs app/api/location's
 * route handler) and client components (DashboardScreen.tsx,
 * AuditScreen.tsx) import from here, instead of client code sourcing this
 * type via a type-only import from lib/location.ts itself, which pulls in
 * prisma/Samsara/OpenWeatherMap runtime dependencies alongside the type
 * (safe today only because `import type` is erased at compile time — this
 * module makes that safety explicit and structural instead of relying on
 * that erasure guarantee).
 *
 * Deliberately imports ONLY from lib/driverContext/types.ts (pure, zero
 * runtime dependencies, verified when this file was created) — never from
 * lib/location.ts itself or any module with server-only I/O (prisma,
 * fetch, provider HTTP clients).
 */

import type { LocationState } from "@/lib/driverContext/types";

export type CardinalHeading = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/**
 * The full success shape returned by GET /api/location — see
 * lib/location.ts's getMockDriverLocation/getPilotDriverLocation for the
 * construction sites this mirrors field-for-field. Field-level doc
 * comments live there, not here, to avoid two copies of the same
 * explanation drifting apart.
 */
export interface LocationApiResponse {
  driverId: string;
  lat: number | null;
  lng: number | null;
  locationLabel: string | null;
  zoneName: string | null;
  zoneRisk: number | null;
  currentSpeed: number | null;
  heading: CardinalHeading | null;
  weatherRisk: number | null;
  checksPassed: number;
  milesDriven: number | null;
  updatedAt: string;
  origin: "observed" | "simulated";
  state: LocationState;
}

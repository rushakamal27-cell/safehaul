/**
 * lib/providers/samsara/vehicleStats.ts
 *
 * HTTP client for two related Samsara vehicle-stats endpoints:
 *   - Vehicle Statistics History (odometer delta → miles driven today)
 *   - Vehicle Statistics current snapshot (GPS position → Phase 1 real location)
 *
 * VALIDATED against a real pilot vehicle on 2026-07-15 (see project_context.md
 * for the full comparison writeup):
 *
 *   GET /fleet/vehicles/stats/history
 *     ?vehicleIds=<id>&types=obdOdometerMeters&startTime=<iso>&endTime=<iso>
 *   -> { data: [{ id, name, externalIds, obdOdometerMeters: [{ time, value }] }],
 *        pagination: { endCursor, hasNextPage } }
 *
 *   - value is METERS (confirmed: a lifetime odometer reading of ~95.4M
 *     matched a plausible ~59,300-mile heavy truck; a same-day delta of
 *     ~286k meters matched a plausible ~178-mile shift).
 *   - time is ISO 8601 with a "Z" suffix (e.g. "2026-07-15T02:52:24Z").
 *   - readings arrived in ascending time order in testing (343 readings
 *     across ~3 hours — a real full-day query WILL paginate), but
 *     odometerDeltaMiles() sorts defensively rather than trusting order.
 *
 *   GET /fleet/trips and GET /fleet/vehicles/{id}/trips were both tested
 *   with this same valid vehicle ID and the "Read Vehicle Trips" permission
 *   granted — both returned a plain-text gateway 404 ("404 page not found",
 *   not a structured Samsara JSON error), unlike the structured 400/401
 *   errors this API returns for bad IDs or missing permissions. Neither is
 *   a real route in this API generation, so Vehicle Statistics History is
 *   SafeHaul's canonical mileage source, not Trips.
 *
 *   Odometer delta also structurally avoids the double-counting risk a
 *   trip-summation approach would have: it's two point-in-time readings on
 *   a monotonically-increasing counter, not summed (and potentially
 *   overlapping) segments.
 */

import { SamsaraApiError } from "./safetyEventsStream";

const SAMSARA_API_BASE = "https://api.samsara.com";
const VEHICLE_STATS_HISTORY_PATH = "/fleet/vehicles/stats/history";
const VEHICLE_STATS_PATH = "/fleet/vehicles/stats";

export interface SamsaraOdometerReading {
  time?: string;
  value?: number;
}

export interface SamsaraVehicleStatsHistoryEntry {
  id?: string;
  name?: string;
  obdOdometerMeters?: SamsaraOdometerReading[];
  [key: string]: unknown;
}

export interface SamsaraVehicleStatsHistoryResponse {
  data: SamsaraVehicleStatsHistoryEntry[];
  pagination: { endCursor: string; hasNextPage: boolean };
}

async function fetchVehicleStatsHistoryPage(params: {
  vehicleId: string;
  startTimeIso: string;
  endTimeIso: string;
  afterCursor?: string;
  signal?: AbortSignal;
}): Promise<SamsaraVehicleStatsHistoryResponse> {
  const token = process.env.SAMSARA_API_TOKEN;
  if (!token) {
    throw new Error("[vehicleStats] SAMSARA_API_TOKEN is not configured");
  }

  const url = new URL(`${SAMSARA_API_BASE}${VEHICLE_STATS_HISTORY_PATH}`);
  url.searchParams.set("vehicleIds", params.vehicleId);
  url.searchParams.set("types", "obdOdometerMeters");
  url.searchParams.set("startTime", params.startTimeIso);
  url.searchParams.set("endTime", params.endTimeIso);
  if (params.afterCursor) url.searchParams.set("after", params.afterCursor);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: params.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SamsaraApiError(
      response.status,
      body,
      `Samsara Vehicle Stats History returned ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<SamsaraVehicleStatsHistoryResponse>;
}

/** Drains pagination.hasNextPage — a full-day window can exceed one page (343 readings covered only ~3 hours in testing). */
export async function fetchVehicleOdometerReadings(params: {
  vehicleId: string;
  startTimeIso: string;
  endTimeIso: string;
  signal?: AbortSignal;
}): Promise<SamsaraOdometerReading[]> {
  const readings: SamsaraOdometerReading[] = [];
  let afterCursor: string | undefined;

  for (;;) {
    const page = await fetchVehicleStatsHistoryPage({ ...params, afterCursor });
    const entry = page.data?.find((d) => d.id === params.vehicleId) ?? page.data?.[0];
    if (entry?.obdOdometerMeters) readings.push(...entry.obdOdometerMeters);

    if (!page.pagination?.hasNextPage || !page.pagination.endCursor) break;
    afterCursor = page.pagination.endCursor;
  }

  return readings;
}

export const METERS_PER_MILE = 1609.344;

/**
 * Pure — miles driven = latest reading - earliest reading, not a summed
 * segments. Sorts defensively rather than trusting response order. Returns
 * null (not 0, not a clamped guess) when there are fewer than 2 valid
 * readings, or when the delta is negative (an odometer rollback is a data
 * anomaly, not "zero miles" — reporting 0 would be a fabricated claim).
 */
export function odometerDeltaMiles(readings: SamsaraOdometerReading[]): number | null {
  const valid = readings
    .filter((r): r is Required<SamsaraOdometerReading> => typeof r.value === "number" && typeof r.time === "string")
    .sort((a, b) => a.time.localeCompare(b.time));

  if (valid.length < 2) return null;

  const deltaMeters = valid[valid.length - 1].value - valid[0].value;
  if (deltaMeters < 0) return null;

  return deltaMeters / METERS_PER_MILE;
}

// ---------------------------------------------------------------------------
// Current GPS snapshot — GET /fleet/vehicles/stats?vehicleIds=...&types=gps
//
// Verified live against both real pilot vehicles on 2026-07-22:
//   { data: [{ id, name, externalIds, gps: {
//       time, latitude, longitude, headingDegrees, speedMilesPerHour,
//       reverseGeo: { formattedLocation }, isEcuSpeed
//   } }], pagination }
//
// `gps` is a single current/latest object (not an array — that's only true
// of the /stats/history variant, which this phase intentionally does not
// use). `time` is ISO 8601 UTC. GPS updates roughly every 5-6 seconds while
// the vehicle is online, so a stale/missing reading is a meaningful signal
// (vehicle off/offline), not a polling artifact — see
// lib/driverContext/assemble.ts::classifyLocationFreshness for thresholds.
// ---------------------------------------------------------------------------

export interface SamsaraGpsReading {
  time?: string;
  latitude?: number;
  longitude?: number;
  headingDegrees?: number;
  speedMilesPerHour?: number;
  reverseGeo?: { formattedLocation?: string };
  isEcuSpeed?: boolean;
}

export interface SamsaraVehicleStatsSnapshotEntry {
  id?: string;
  name?: string;
  externalIds?: Record<string, string>;
  gps?: SamsaraGpsReading;
  [key: string]: unknown;
}

export interface SamsaraVehicleStatsSnapshotResponse {
  data: SamsaraVehicleStatsSnapshotEntry[];
  pagination: { endCursor: string; hasNextPage: boolean };
}

/** Fetches the current GPS snapshot for one vehicle. No pagination — the snapshot endpoint returns at most one reading per requested vehicle. */
export async function fetchVehicleGpsSnapshot(params: {
  vehicleId: string;
  signal?: AbortSignal;
}): Promise<SamsaraVehicleStatsSnapshotResponse> {
  const token = process.env.SAMSARA_API_TOKEN;
  if (!token) {
    throw new Error("[vehicleStats] SAMSARA_API_TOKEN is not configured");
  }

  const url = new URL(`${SAMSARA_API_BASE}${VEHICLE_STATS_PATH}`);
  url.searchParams.set("vehicleIds", params.vehicleId);
  url.searchParams.set("types", "gps");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: params.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SamsaraApiError(
      response.status,
      body,
      `Samsara Vehicle Stats (gps) returned ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<SamsaraVehicleStatsSnapshotResponse>;
}

export interface NormalizedGpsReading {
  providerVehicleId: string;
  vehicleName: string | null;
  latitude: number;
  longitude: number;
  observedAt: string;
  headingDegrees: number | null;
  speedMilesPerHour: number | null;
  isEcuSpeed: boolean | null;
  formattedLocation: string | null;
}

function isValidLatitude(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v >= -90 && v <= 90;
}

function isValidLongitude(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v >= -180 && v <= 180;
}

function isValidTimestamp(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && isFinite(new Date(v).getTime());
}

/**
 * Pure — parses and validates one GPS snapshot response for the exact
 * requested vehicle. Returns null (never a fabricated or another vehicle's
 * reading) when:
 *   - the requested vehicle isn't in the response data at all (stricter than
 *     odometerDeltaMiles's sibling fetch, which falls back to data[0] — GPS
 *     position is safety-sensitive enough that guessing a different
 *     vehicle's location is worse than reporting unavailable);
 *   - the entry has no `gps` object;
 *   - latitude/longitude are missing or out of range;
 *   - the timestamp is missing or unparseable.
 */
export function normalizeVehicleGpsSnapshot(
  response: SamsaraVehicleStatsSnapshotResponse,
  requestedVehicleId: string
): NormalizedGpsReading | null {
  const entry = response.data?.find((d) => d.id === requestedVehicleId);
  if (!entry?.gps) return null;

  const { latitude, longitude, time, headingDegrees, speedMilesPerHour, isEcuSpeed, reverseGeo } = entry.gps;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude) || !isValidTimestamp(time)) return null;

  return {
    providerVehicleId: requestedVehicleId,
    vehicleName: typeof entry.name === "string" ? entry.name : null,
    latitude,
    longitude,
    observedAt: time,
    headingDegrees: typeof headingDegrees === "number" && isFinite(headingDegrees) ? headingDegrees : null,
    speedMilesPerHour: typeof speedMilesPerHour === "number" && isFinite(speedMilesPerHour) ? speedMilesPerHour : null,
    isEcuSpeed: typeof isEcuSpeed === "boolean" ? isEcuSpeed : null,
    formattedLocation: typeof reverseGeo?.formattedLocation === "string" ? reverseGeo.formattedLocation : null,
  };
}

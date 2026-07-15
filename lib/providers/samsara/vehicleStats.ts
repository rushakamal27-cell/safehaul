/**
 * lib/providers/samsara/vehicleStats.ts
 *
 * HTTP client for Samsara's Vehicle Statistics History endpoint, used to
 * compute a pilot vehicle's miles driven for the current day via odometer
 * delta (latest reading minus earliest reading in the requested window).
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

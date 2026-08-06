/**
 * lib/providers/samsara/hos.ts
 *
 * HTTP client + parsing for Samsara's Hours-of-Service clocks endpoint.
 *
 * Endpoint path CONFIRMED live on 2026-07-15 against the real pilot driver:
 * GET /fleet/hos/clocks?driverIds=<id> returned 200 with the assumed
 * envelope shape ({ data: [], pagination: { endCursor, hasNextPage } }).
 *
 * TODO: The pilot driver had no active HOS clock at validation time
 * (data: [] — a legitimate "unavailable" case, correctly handled below),
 * so entry-level fields (`clocks.drive.durationMsRemaining`,
 * `clocks.shift.durationMsElapsed`, `lastUpdatedAtTime`, units) remain
 * UNVALIDATED — there was no real entry to check them against. Re-validate
 * against a live call made while the pilot driver has an active clock
 * before trusting these field names/units in production. All fields are
 * parsed defensively so a shape mismatch degrades to "unavailable" rather
 * than returning a wrong or fabricated number.
 */

import { SamsaraApiError } from "./safetyEventsStream";

const SAMSARA_API_BASE = "https://api.samsara.com";
const HOS_CLOCKS_PATH = "/fleet/hos/clocks";

/** HOS clock data is treated as stale (not silently "available") once older than this. See docs/data-freshness.md for how this compares to the other freshness thresholds in the codebase. */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export interface SamsaraHosClockEntry {
  driver?: { id?: string; name?: string };
  /** TODO: still unvalidated — see file header. Field names/units (ms) assumed, matching Samsara's other duration fields. */
  clocks?: {
    drive?: { durationMsRemaining?: number };
    shift?: { durationMsRemaining?: number; durationMsElapsed?: number };
  };
  /** TODO: confirm the actual "as of" timestamp field name Samsara returns here. */
  lastUpdatedAtTime?: string;
  [key: string]: unknown;
}

export interface SamsaraHosClocksResponse {
  data: SamsaraHosClockEntry[];
}

export async function fetchSamsaraHosClocks(params: {
  driverIds: string[];
  signal?: AbortSignal;
}): Promise<SamsaraHosClocksResponse> {
  const token = process.env.SAMSARA_API_TOKEN;
  if (!token) {
    throw new Error("[hos] SAMSARA_API_TOKEN is not configured");
  }

  const url = new URL(`${SAMSARA_API_BASE}${HOS_CLOCKS_PATH}`);
  url.searchParams.set("driverIds", params.driverIds.join(","));

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
      `Samsara HOS Clocks returned ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<SamsaraHosClocksResponse>;
}

export interface ParsedHos {
  drivingHoursRemaining: number | null;
  shiftHoursUsed: number | null;
  status: "available" | "unavailable" | "stale";
  updatedAt: string | null;
}

/**
 * Pure — converts one Samsara HOS clock entry into our shape. `shiftHoursUsed`
 * (on-duty/shift elapsed time) is the value that feeds the risk engine's
 * fatigue penalty — it matches the pre-existing mock's "hours on duty in
 * current cycle" semantics more directly than deriving a driving-time-used
 * figure from the daily drive-time limit would.
 */
export function parseHosClockEntry(
  entry: SamsaraHosClockEntry | undefined,
  now: Date
): ParsedHos {
  if (!entry) {
    return { drivingHoursRemaining: null, shiftHoursUsed: null, status: "unavailable", updatedAt: null };
  }

  const driveMsRemaining = entry.clocks?.drive?.durationMsRemaining;
  const shiftMsElapsed = entry.clocks?.shift?.durationMsElapsed;
  const updatedAt = entry.lastUpdatedAtTime ?? null;

  const drivingHoursRemaining = typeof driveMsRemaining === "number" ? driveMsRemaining / 3_600_000 : null;
  const shiftHoursUsed = typeof shiftMsElapsed === "number" ? shiftMsElapsed / 3_600_000 : null;

  if (shiftHoursUsed === null) {
    return { drivingHoursRemaining, shiftHoursUsed: null, status: "unavailable", updatedAt };
  }

  const isStale = updatedAt !== null && now.getTime() - new Date(updatedAt).getTime() > STALE_THRESHOLD_MS;

  return {
    drivingHoursRemaining,
    shiftHoursUsed,
    status: isStale ? "stale" : "available",
    updatedAt,
  };
}

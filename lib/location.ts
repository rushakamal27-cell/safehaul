/**
 * lib/location.ts
 *
 * Operational context layer for SafeHaul — backs app/api/location.
 *
 * Two paths, matching the trust rules already established for DriverContext
 * (lib/driverContext/assemble.ts):
 *   - getUnavailableDriverLocation: drivers with no active pilot mapping —
 *     every provider-derived field null, state "unavailable". Was
 *     getMockDriverLocation, fully scenario-driven via lib/samsara.ts, until
 *     Remove Implicit Demo Fallback (2026-10-08); the driver's real
 *     Inspection count is the one field it still returns.
 *   - getPilotDriverLocation (Phase 2, extended Phase 5): pilot drivers —
 *     reuses lib/driverContext/assemble.ts's assembleLocation/assembleWeather/
 *     assembleZoneRisk/assembleSpeed directly rather than duplicating
 *     vehicle-ID resolution / GPS-fetch / freshness / gating logic here.
 *     lat/lng/locationLabel/zoneName/zoneRisk/currentSpeed/weatherRisk are
 *     all real-or-null, never a mock scenario value — fresh/stale/unavailable
 *     `state` matches /api/risk's location semantics exactly, by
 *     construction (same assembleLocation call, and weather/zone/speed reuse
 *     its already-resolved locationDetail rather than re-fetching GPS).
 *
 * Phase 5 note: zoneName/zoneRisk/currentSpeed/weatherRisk used to be
 * hardcoded null for pilots here, with a comment claiming real zone risk and
 * real speed were "not-yet-started phases" — that became stale the moment
 * Phase 3 (zone risk) and Phase 4 (speed) shipped in /api/risk, leaving this
 * endpoint quietly reporting "unavailable" for data that was actually live.
 * These fields don't get their own per-field origin/state the way
 * ContextSources does in /api/risk — they share this response's single
 * top-level `state`, since all three are gated on that exact same
 * locationDetail.state === "fresh" condition (see assembleWeather/
 * assembleZoneRisk/assembleSpeed in assemble.ts). A field can still
 * legitimately be null even when `state` is "fresh" (e.g. GPS position
 * outside every curated zone, or a failed weather call) — that's a real
 * per-field gap, not a mislabeled `state`. checksPassed/milesDriven ARE
 * already real for pilots (lib/todaySummary.ts), so those are included
 * as-is — reusing an existing real source, not new assembly.
 */

import { fetchTodaySummaryData } from "@/lib/todaySummary";
import { assembleLocation, assembleWeather, assembleZoneRisk, assembleSpeed } from "@/lib/driverContext/assemble";
import type { LocationApiResponse } from "@/lib/api/location";

// The response type (LocationApiResponse) and its field-by-field meaning —
// driverId/lat/lng/locationLabel/zoneName/zoneRisk/currentSpeed/heading/
// weatherRisk/checksPassed/milesDriven/updatedAt/origin/state — now live in
// lib/api/location.ts (N4, Phase 5, 2026-08-05), the shared, zero-server-
// dependency module both this file and client components import from. See
// that file for the full field comments (unchanged from before this move).

/**
 * Non-pilot path. Remove Implicit Demo Fallback (2026-10-08): renamed from
 * getMockDriverLocation, and no longer mock.
 *
 * It used to compose lib/samsara.ts's getDriverVehicleContext +
 * getDriverDailySummary, which meant a normal user with no provider mapping
 * received fabricated coordinates, a fabricated location label, a fabricated
 * zone name and risk, a fabricated speed, a hardcoded heading of "W", a
 * fabricated weather risk, a fabricated mileage figure AND a fabricated
 * inspection count — reported as origin "simulated", state "fresh".
 *
 * Every provider-derived field is now null with state "unavailable".
 *
 * checksPassed is the one exception, and deliberately so: it comes from
 * fetchTodaySummaryData, which counts real Inspection rows for this driver.
 * A driver with no telematics mapping can still have completed genuine
 * vehicle inspections in SafeHaul, and that is a verified database fact we
 * own. Removing implicit demo data must not also remove real data — so this
 * stays, while the mock getMockInspectionSummary value it used to carry does
 * not. isPilot=false is passed through, so milesDriven comes back null
 * (see lib/todaySummary.ts::resolveMilesDriven) rather than a mock constant.
 */
export async function getUnavailableDriverLocation(driverId: string): Promise<LocationApiResponse> {
  const summary = await fetchTodaySummaryData(driverId, false);

  return {
    driverId,
    lat:           null,
    lng:           null,
    locationLabel: null,
    zoneName:      null,
    zoneRisk:      null,
    currentSpeed:  null,
    heading:       null,
    weatherRisk:   null,
    checksPassed:  summary.checksPassed,
    milesDriven:   summary.milesDriven,
    updatedAt:     new Date().toISOString(),
    origin:        null,
    state:         "unavailable",
  };
}

/**
 * Pilot path — reuses assembleLocation verbatim (no duplicated Samsara/
 * freshness logic), then reuses assembleWeather/assembleZoneRisk/
 * assembleSpeed the same way assembleDriverContext does (Phase 5): each
 * takes the already-resolved locationDetail as a parameter rather than
 * re-fetching GPS, and each applies its own real-or-unavailable gating
 * exactly as it does for /api/risk — this endpoint is not a second
 * implementation of that trust logic, just a second consumer of it.
 *
 * lat/lng/locationLabel are null whenever assembleLocation's state is
 * "unavailable"; they're still populated (real) for "stale", for the same
 * transparency reason DriverContext.location preserves stale coordinates
 * rather than hiding them. zoneName/zoneRisk/currentSpeed/weatherRisk can
 * each independently be null (e.g. GPS outside every curated zone, or a
 * failed weather call) even when `state` is "fresh" — see the
 * LocationApiResponse field comments in lib/api/location.ts.
 *
 * Deliberately does NOT call assembleSafetyEvents/assembleHos (i.e. not the
 * full assembleDriverContext) — those would trigger an on-demand Samsara
 * sync and an extra HOS call this endpoint has never made and doesn't need,
 * just to answer a location/weather/zone/speed question.
 */
export async function getPilotDriverLocation(driverId: string): Promise<LocationApiResponse> {
  const now = new Date().toISOString();
  const [{ detail }, summary] = await Promise.all([
    assembleLocation(driverId, true, now),
    fetchTodaySummaryData(driverId, true),
  ]);

  const [weatherResult, zoneRiskResult] = await Promise.all([
    assembleWeather(driverId, true, now, detail),
    assembleZoneRisk(driverId, true, now, detail),
  ]);
  const speedResult = assembleSpeed(driverId, true, now, detail);

  return {
    driverId,
    lat:           detail.latitude,
    lng:           detail.longitude,
    locationLabel: detail.formattedLocation ?? null,
    zoneName:      zoneRiskResult.detail.zoneName,
    zoneRisk:      zoneRiskResult.detail.zoneRisk,
    currentSpeed:  speedResult.field.value,
    heading:       null,
    weatherRisk:   weatherResult.detail.weatherRisk,
    checksPassed:  summary.checksPassed,
    milesDriven:   summary.milesDriven,
    updatedAt:     now,
    origin:        "observed",
    state:         detail.state,
  };
}

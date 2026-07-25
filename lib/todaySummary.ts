/**
 * lib/todaySummary.ts
 *
 * Assembles the Heads-Up "Today's Summary" numbers for /api/risk: checks
 * passed and miles driven. alertsActive is intentionally NOT computed here
 * — it's derived by the /api/risk route from the already-computed risk
 * result (result.factors.length), since this module has no reason to depend
 * on lib/riskEngine.
 *
 * Vehicle resolution for mileage is shared with GPS location resolution via
 * lib/providers/samsara/vehicleId.ts::resolveCurrentVehicleId — see that file
 * for why the DriverProviderMapping value isn't trusted blindly.
 *
 * Mileage is computed via Samsara Vehicle Statistics History odometer delta,
 * not the Trips API — GET /fleet/trips and GET /fleet/vehicles/{id}/trips
 * were both confirmed to not exist in this API generation during live
 * validation on 2026-07-15 (see lib/providers/samsara/vehicleStats.ts).
 *
 * "Today" uses the UTC calendar day, matching the existing day boundary
 * already used for Trip/ComplianceScore (lib/trip.ts, app/api/risk/route.ts)
 * — SafeHaul has no stored per-driver/company timezone yet, so this is a
 * known simplification, not a true "local calendar day." The `timezone`
 * field in the response reports "UTC" honestly rather than overstating
 * precision.
 */

import { prisma } from "@/lib/prisma";
import { getScenarioForDriver } from "@/lib/mockScenarios";
import { getMockTripStats } from "@/lib/samsara";
import { fetchVehicleOdometerReadings, odometerDeltaMiles } from "@/lib/providers/samsara/vehicleStats";
import { resolveCurrentVehicleId } from "@/lib/providers/samsara/vehicleId";

const VEHICLE_STATS_FETCH_TIMEOUT_MS = 8_000;

export type DataAvailability = "available" | "unavailable";

export interface TodaySummaryData {
  checksPassed: number;
  milesDriven: number | null;
  dataStatus: {
    checks: DataAvailability;
    mileage: DataAvailability;
  };
}

/** Pure — UTC calendar day bounds for a given instant. */
export function utcDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

async function resolveChecksPassed(
  driverId: string,
  dayStart: Date
): Promise<{ checksPassed: number; status: DataAvailability }> {
  try {
    const checksPassed = await prisma.inspection.count({
      where: { driverId, overallResult: "PASS", createdAt: { gte: dayStart } },
    });
    return { checksPassed, status: "available" };
  } catch (err) {
    console.error("[todaySummary] Inspection count failed:", err instanceof Error ? err.message : err);
    return { checksPassed: 0, status: "unavailable" };
  }
}

async function resolveMilesDriven(
  driverId: string,
  isPilot: boolean,
  dayStart: Date,
  dayEnd: Date
): Promise<{ milesDriven: number | null; status: DataAvailability }> {
  if (!isPilot) {
    const scenario = getScenarioForDriver(driverId);
    return { milesDriven: Math.round(getMockTripStats(scenario).milesDrivenToday), status: "available" };
  }

  const { vehicleId } = await resolveCurrentVehicleId(driverId);
  if (!vehicleId) return { milesDriven: null, status: "unavailable" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VEHICLE_STATS_FETCH_TIMEOUT_MS);

  try {
    const readings = await fetchVehicleOdometerReadings({
      vehicleId,
      startTimeIso: dayStart.toISOString(),
      endTimeIso: dayEnd.toISOString(),
      signal: controller.signal,
    });
    const miles = odometerDeltaMiles(readings);
    return miles === null ? { milesDriven: null, status: "unavailable" } : { milesDriven: Math.round(miles), status: "available" };
  } catch (err) {
    console.error("[todaySummary] Samsara vehicle stats fetch failed:", err instanceof Error ? err.message : err);
    return { milesDriven: null, status: "unavailable" };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchTodaySummaryData(driverId: string, isPilot: boolean): Promise<TodaySummaryData> {
  const { start, end } = utcDayBounds(new Date());

  const [checks, mileage] = await Promise.all([
    resolveChecksPassed(driverId, start),
    resolveMilesDriven(driverId, isPilot, start, end),
  ]);

  return {
    checksPassed: checks.checksPassed,
    milesDriven: mileage.milesDriven,
    dataStatus: { checks: checks.status, mileage: mileage.status },
  };
}

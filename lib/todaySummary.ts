/**
 * lib/todaySummary.ts
 *
 * Assembles the Heads-Up "Today's Summary" numbers for /api/risk: checks
 * passed and miles driven. alertsActive is intentionally NOT computed here
 * — it's derived by the /api/risk route from the already-computed risk
 * result (result.factors.length), since this module has no reason to depend
 * on lib/riskEngine.
 *
 * Vehicle resolution for mileage prefers DriverProviderMapping.externalVehicleId
 * (the durable assignment) and falls back to the most recent DriverEvent's
 * externalVehicleId for pilot drivers with no mapping set yet — see
 * looksLikeSamsaraId() below for why the mapping value isn't trusted blindly.
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

/**
 * Samsara-issued IDs (driver, vehicle, event) have been numeric strings in
 * every example seen so far. Live validation on 2026-07-15 found the pilot
 * DriverProviderMapping's externalVehicleId held a human-readable vehicle
 * display name instead of a Samsara ID — the mapping was seeded incorrectly.
 * A non-numeric mapping value is treated the same as a missing one (fall
 * through to the DriverEvent-sourced ID) rather than being sent to Samsara,
 * where it's guaranteed to 400. This does not fix the underlying bad row —
 * that should still be corrected at the source.
 */
function looksLikeSamsaraId(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Resolves the vehicle currently assigned to a pilot driver.
 * Primary: DriverProviderMapping.externalVehicleId (durable assignment),
 * when it's Samsara-ID-shaped. Fallback: the most recent
 * DriverEvent.externalVehicleId for the driver — covers pilots whose
 * mapping row predates externalVehicleId being set correctly.
 */
async function resolveVehicleId(driverId: string): Promise<string | null> {
  const mapping = await prisma.driverProviderMapping.findFirst({
    where: { driverId, isPilot: true, isActive: true },
    select: { externalVehicleId: true },
  });
  if (mapping?.externalVehicleId && looksLikeSamsaraId(mapping.externalVehicleId)) {
    return mapping.externalVehicleId;
  }

  const latestEvent = await prisma.driverEvent.findFirst({
    where: { driverId, externalVehicleId: { not: null } },
    orderBy: { timestamp: "desc" },
    select: { externalVehicleId: true },
  });
  return latestEvent?.externalVehicleId ?? null;
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

  const vehicleId = await resolveVehicleId(driverId);
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

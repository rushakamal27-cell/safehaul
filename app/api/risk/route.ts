import { NextRequest, NextResponse } from "next/server";
import { calculateRisk } from "@/lib/riskEngine";
import { getDriverVehicleContext, getDriverDailySummary } from "@/lib/samsara";
import { isPilotDriver } from "@/lib/driverEvents";
import { assembleDriverContext } from "@/lib/driverContext/assemble";
import { toRiskInput } from "@/lib/driverContext/toRiskInput";
import { toContextSources } from "@/lib/driverContext/toContextSources";
import { deriveContextStatus } from "@/lib/driverContext/contextStatus";
import { fetchTodaySummaryData } from "@/lib/todaySummary";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma";
import { getOrCreateTodayTrip } from "@/lib/trip";

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  const pilotDriver = await isPilotDriver(driverId);

  const [assembled, vehicle, tripId, daily, summaryData] = await Promise.all([
    assembleDriverContext(driverId, pilotDriver),
    getDriverVehicleContext(driverId),
    getOrCreateTodayTrip(driverId),
    getDriverDailySummary(driverId),
    fetchTodaySummaryData(driverId, pilotDriver),
  ]);

  const { context, liveData, hosDetail, locationDetail, weatherDetail } = assembled;
  const input = toRiskInput(context);
  const contextSources = toContextSources(context);
  const contextStatus = deriveContextStatus(context);
  const result = calculateRisk(input);
  const alertsActive = result.factors.length;

  // Stamp current mileage and environmental snapshot on the active trip.
  // Both are updated on every call — mileage accumulates, conditions change.
  //
  // Phase 2 note: `vehicle` (getDriverVehicleContext) is still 100% mock
  // scenario data — zoneRisk/zoneName stay sourced from it for everyone,
  // since real zone risk is out of scope this phase. weatherRisk/locationLabel
  // are different: real values now exist for pilots (weatherDetail,
  // locationDetail), and this Trip.weatherData blob is surfaced verbatim in
  // the Audit view (app/api/audit/route.ts's "Daily Trip" entries) — letting
  // it keep showing mock weather/location for a pilot here would silently
  // reintroduce the exact "real-looking but wrong" problem this phase exists
  // to fix, even though DriverContext.weather itself is now correct.
  const weatherDataSnapshot = pilotDriver
    ? {
        weatherRisk:   weatherDetail.weatherRisk,      // real (or null when unavailable) — never the mock scenario value for a pilot
        zoneRisk:      vehicle.zoneRisk,                // still mock — zone risk is out of scope for this phase
        locationLabel: locationDetail.formattedLocation, // real reverse-geo (or null) — never the mock scenario label for a pilot
        zoneName:      vehicle.zoneName,                // still mock — zone risk is out of scope for this phase
      }
    : {
        weatherRisk:   vehicle.weatherRisk,
        zoneRisk:      vehicle.zoneRisk,
        locationLabel: vehicle.locationLabel,
        zoneName:      vehicle.zoneName,
      };

  await prisma.trip.update({
    where: { id: tripId },
    data:  {
      milesDriven: daily.milesDriven,
      weatherData: weatherDataSnapshot,
    },
  });

  // Persist one ComplianceScore row per driver per UTC calendar day.
  // findFirst + conditional create avoids duplicates without a schema migration.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const existing = await prisma.complianceScore.findFirst({
    where: { driverId, date: today },
    select: { id: true },
  });

  if (!existing) {
    await prisma.complianceScore.create({
      data: {
        driverId,
        date:          today,
        score:         result.score,
        dangerLevel:   result.level,
        breakdownJson: result.factors as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Persist today's safety events for non-pilot drivers only.
  // Pilot drivers: real events live in DriverEvent (via webhook pipeline) — no duplication.
  // Guard prevents re-writing identical scenario events on repeated refreshes.
  if (!pilotDriver && input.safetyEvents.length > 0) {
    const existingEvent = await prisma.safetyEvent.findFirst({
      where: { driverId, timestamp: { gte: today } },
      select: { id: true },
    });

    if (!existingEvent) {
      const now = new Date();
      await prisma.safetyEvent.createMany({
        data: input.safetyEvents.map((ev) => ({
          driverId,
          tripId,
          eventType: ev.type,
          severity:  String(ev.severity),
          timestamp: now,
          lat:       vehicle.lat,
          lng:       vehicle.lng,
        })),
      });
    }
  }

  return NextResponse.json({
    driverId,
    timestamp:  new Date().toISOString(),
    // dataSource: which connection path this driver is on (pilot provider vs.
    // demo). Kept for backward compatibility — do not rename/remove yet.
    // contextStatus is the field that should be trusted for "is this score
    // actually live": a pilot driver can be dataSource "real" while still
    // partial_live, because speed/zoneRisk aren't sourced from a real
    // provider yet even though safety events and HOS are.
    dataSource: pilotDriver ? "real" : "mock",
    contextStatus,
    contextSources,
    liveData,
    hos: hosDetail,
    // Phase 1 — Real GPS: transparency-only breakdown, same relationship to
    // contextSources.location that `hos` above has to contextSources.hos.
    // speedMilesPerHour is exposed for future use only — not consumed by
    // the risk engine yet (see lib/driverContext/toRiskInput.ts).
    location: locationDetail,
    // Phase 2 — Weather from Real Vehicle GPS: transparency-only breakdown,
    // same relationship to contextSources.weather that `location` above has
    // to contextSources.location. latitude/longitude here are the
    // coordinates a weather request actually used (or was attempted with);
    // locationState/locationObservedAt explain *why* pilot weather is
    // unavailable when it is, without cross-referencing `location` above.
    weather: weatherDetail,
    todaySummary: {
      checksPassed: summaryData.checksPassed,
      milesDriven:  summaryData.milesDriven,
      alertsActive,
      timezone: "UTC",
      dataStatus: {
        checks:   summaryData.dataStatus.checks,
        mileage:  summaryData.dataStatus.mileage,
        alerts:   "available",
      },
    },
    input,
    result,
  });
}

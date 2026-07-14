import { NextRequest, NextResponse } from "next/server";
import { calculateRisk } from "@/lib/riskEngine";
import { getDriverVehicleContext, getDriverDailySummary } from "@/lib/samsara";
import { assembleDriverContext } from "@/lib/driverContext/assemble";
import { toRiskInput } from "@/lib/driverContext/toRiskInput";
import { toContextSources } from "@/lib/driverContext/toContextSources";
import { deriveContextStatus } from "@/lib/driverContext/contextStatus";
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

  const [assembled, vehicle, tripId, daily] = await Promise.all([
    assembleDriverContext(driverId),
    getDriverVehicleContext(driverId),
    getOrCreateTodayTrip(driverId),
    getDriverDailySummary(driverId),
  ]);

  const { context, isPilot: pilotDriver, liveData } = assembled;
  const input = toRiskInput(context);
  const contextSources = toContextSources(context);
  const contextStatus = deriveContextStatus(context);
  const result = calculateRisk(input);

  // Stamp current mileage and environmental snapshot on the active trip.
  // Both are updated on every call — mileage accumulates, conditions change.
  await prisma.trip.update({
    where: { id: tripId },
    data:  {
      milesDriven: daily.milesDriven,
      weatherData: {
        weatherRisk:   vehicle.weatherRisk,
        zoneRisk:      vehicle.zoneRisk,
        locationLabel: vehicle.locationLabel,
        zoneName:      vehicle.zoneName,
      },
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
    // partial_live, because HOS/speed/zoneRisk aren't sourced from a real
    // provider yet even though safety events are.
    dataSource: pilotDriver ? "real" : "mock",
    contextStatus,
    contextSources,
    liveData,
    input,
    result,
  });
}

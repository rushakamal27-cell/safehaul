import { NextRequest, NextResponse } from "next/server";
import { calculateRisk } from "@/lib/riskEngine";
import { getRiskInputForDriver, getDriverVehicleContext, getDriverDailySummary } from "@/lib/samsara";
import { prisma } from "@/lib/prisma";
import { getOrCreateTodayTrip } from "@/lib/trip";

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  const [input, vehicle, tripId, daily] = await Promise.all([
    getRiskInputForDriver(driverId),
    getDriverVehicleContext(driverId),
    getOrCreateTodayTrip(driverId),
    getDriverDailySummary(driverId),
  ]);
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
        breakdownJson: result.factors,  // [{ name, impact }, ...]
      },
    });
  }

  // Persist today's safety events if none yet recorded for this driver today.
  // Guard prevents re-writing identical scenario events on repeated refreshes.
  if (input.safetyEvents.length > 0) {
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
    timestamp: new Date().toISOString(),
    input,
    result,
  });
}

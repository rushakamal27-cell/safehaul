import { NextRequest, NextResponse } from "next/server";
import { calculateRisk } from "@/lib/riskEngine";
import { getRiskInputForDriver, getDriverVehicleContext, getDriverDailySummary } from "@/lib/samsara";
import { isPilotDriver, getRecentDriverEvents, driverEventsToRiskSafetyEvents } from "@/lib/driverEvents";
import { ensureFreshSamsaraSync, type OnDemandSyncStatus } from "@/lib/providers/samsara/onDemandSync";
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

  const [input, vehicle, tripId, daily, pilotDriver] = await Promise.all([
    getRiskInputForDriver(driverId),
    getDriverVehicleContext(driverId),
    getOrCreateTodayTrip(driverId),
    getDriverDailySummary(driverId),
    isPilotDriver(driverId),
  ]);

  // Hybrid input: pilot drivers get real DriverEvent rows; non-pilots keep mock scenario.
  // For pilot drivers, real events fully replace the mock safetyEvents array.
  // An empty real-events array means the pilot has a clean window — score reflects that.
  let liveData: {
    provider: string;
    lastEventType: string | null;
    lastEventTimestamp: string | null;
    lastSyncTime: string | null;
    driverEventCount24h: number;
    syncStatus: OnDemandSyncStatus;
  } | null = null;

  if (pilotDriver) {
    // Refresh Samsara data on-demand if it's stale — replaces the removed
    // 5-minute cron (Hobby plan). No-ops (status "fresh") on the common path.
    const syncDecision = await ensureFreshSamsaraSync();

    console.info(
      JSON.stringify({
        msg: "on_demand_sync_decision",
        driverId,
        previousLastSyncAt: syncDecision.previousLastSyncAt?.toISOString() ?? null,
        status: syncDecision.status,
        elapsedMs: syncDecision.elapsedMs,
      })
    );

    // Re-read events after the (possible) sync so scoring reflects any newly stored data.
    const [realEvents, mapping, syncState] = await Promise.all([
      getRecentDriverEvents(driverId),
      prisma.driverProviderMapping.findFirst({
        where: { driverId, isPilot: true, isActive: true },
        select: { provider: true },
      }),
      prisma.providerSyncState.findFirst({
        where: { provider: "samsara", streamKey: "safety-events" },
        select: { lastSyncAt: true },
      }),
    ]);

    input.safetyEvents = driverEventsToRiskSafetyEvents(realEvents);

    liveData = {
      provider: mapping?.provider ?? "samsara",
      lastEventType: realEvents[0]?.type ?? null,
      lastEventTimestamp: realEvents[0]?.timestamp.toISOString() ?? null,
      lastSyncTime: syncState?.lastSyncAt?.toISOString() ?? null,
      driverEventCount24h: realEvents.length,
      syncStatus: syncDecision.status,
    };
  }

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
    dataSource: pilotDriver ? "real" : "mock",
    liveData,
    input,
    result,
  });
}

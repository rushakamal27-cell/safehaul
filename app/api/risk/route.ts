import { NextRequest, NextResponse } from "next/server";
import { calculateRisk } from "@/lib/riskEngine";
import { getDriverVehicleContext } from "@/lib/samsara";
import { isPilotDriver } from "@/lib/driverEvents";
import { assembleDriverContext } from "@/lib/driverContext/assemble";
import { toRiskInput } from "@/lib/driverContext/toRiskInput";
import { toContextSources } from "@/lib/driverContext/toContextSources";
import { deriveContextStatus, deriveDataCompleteness } from "@/lib/driverContext/contextStatus";
import { fetchTodaySummaryData } from "@/lib/todaySummary";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma";
import { getOrCreateTodayTrip } from "@/lib/trip";
import type { ApiErrorResponse } from "@/lib/api/common";
import type { RiskApiResponse } from "@/lib/api/risk";

// Return type is explicitly checked against the shared contract
// (lib/api/risk.ts) both routes and client components import — an object
// literal returned as NextResponse<RiskApiResponse> that's missing a field,
// has an extra one, or mismatches a field's type fails `tsc --noEmit`
// immediately (N4, Phase 5, 2026-08-05), instead of silently drifting from
// what DashboardScreen.tsx's now-shared type expects.
export async function GET(request: NextRequest): Promise<NextResponse<RiskApiResponse | ApiErrorResponse>> {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  try {
    return await buildRiskResponse(driverId);
  } catch (error) {
    // Server-side only: full error (including stack) for debugging, plus
    // the internal driverId for correlation — never sent to the client.
    // Never logs provider payloads or raw DB row contents, only whatever
    // the thrown error itself carries (typically a message/stack, per
    // Node's default Error shape) — matches the existing precedent in
    // app/api/driver/route.ts and app/api/incident/route.ts.
    console.error(`[api/risk] Unhandled error for driverId=${driverId}:`, error);
    return NextResponse.json(
      { error: "Unable to compute risk data right now. Please try again." },
      { status: 500 }
    );
  }
}

async function buildRiskResponse(driverId: string): Promise<NextResponse<RiskApiResponse>> {
  const pilotDriver = await isPilotDriver(driverId);

  const [assembled, vehicle, tripId, summaryData] = await Promise.all([
    assembleDriverContext(driverId, pilotDriver),
    getDriverVehicleContext(driverId),
    getOrCreateTodayTrip(driverId),
    fetchTodaySummaryData(driverId, pilotDriver),
  ]);

  const { context, liveData, hosDetail, locationDetail, weatherDetail, zoneDetail } = assembled;
  const input = toRiskInput(context);
  const contextSources = toContextSources(context);
  const contextStatus = deriveContextStatus(context);
  const dataCompleteness = deriveDataCompleteness(context);
  const result = calculateRisk(input);
  const alertsActive = result.factors.length;

  // Stamp current mileage and environmental snapshot on the active trip.
  // Both are updated on every call — mileage accumulates, conditions change.
  //
  // `vehicle` (getDriverVehicleContext) is still 100% mock scenario data —
  // it remains the source for demo drivers here. For pilots, every field in
  // this snapshot is now real (or null when unavailable): weatherRisk/
  // locationLabel since Phase 2, zoneRisk/zoneName since Phase 3
  // (zoneDetail). This Trip.weatherData blob is surfaced verbatim in the
  // Audit view (app/api/audit/route.ts's "Daily Trip" entries) — letting it
  // keep showing mock data for a pilot here would silently reintroduce the
  // exact "real-looking but wrong" problem Phase 2 exists to fix, even
  // though DriverContext itself is now correct.
  const weatherDataSnapshot = pilotDriver
    ? {
        weatherRisk:   weatherDetail.weatherRisk,      // real (or null when unavailable) — never the mock scenario value for a pilot
        zoneRisk:      zoneDetail.zoneRisk,             // real (or null when unavailable) — never the mock scenario value for a pilot
        locationLabel: locationDetail.formattedLocation, // real reverse-geo (or null) — never the mock scenario label for a pilot
        zoneName:      zoneDetail.zoneName,             // real (or null) — never the mock scenario name for a pilot
      }
    : {
        weatherRisk:   vehicle.weatherRisk,
        zoneRisk:      vehicle.zoneRisk,
        locationLabel: vehicle.locationLabel,
        zoneName:      vehicle.zoneName,
      };

  // milesDriven: same real-per-pilot source as todaySummary.milesDriven below
  // (summaryData, from fetchTodaySummaryData) — previously this used a
  // separate mock-only getDriverDailySummary() call, so the persisted Trip
  // row silently disagreed with the real value shown in the API response.
  // When the real value is unavailable, the field is omitted rather than
  // written as a fabricated 0, preserving the last known real mileage.
  await prisma.trip.update({
    where: { id: tripId },
    data:  {
      ...(summaryData.milesDriven !== null ? { milesDriven: summaryData.milesDriven } : {}),
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
    // Reuses assembleDriverContext's own calculation instant rather than a
    // second, independently-computed `new Date()` — guarantees this equals
    // location.fetchedAt/weather.fetchedAt/zone.fetchedAt below, all of
    // which are threaded from that same instant. This is a SafeHaul
    // calculation timestamp, not a provider event timestamp — see
    // docs/data-freshness.md.
    timestamp:  assembled.calculatedAt,
    // dataSource: which connection path this driver is on (pilot provider vs.
    // demo). Kept for backward compatibility — do not rename/remove yet.
    // contextStatus is the field that should be trusted for "is this score
    // actually live": a pilot driver can be dataSource "real" while still
    // partial_live if any single field (safety events, HOS, speed, weather,
    // zone risk) isn't currently observed-and-fresh — e.g. speed/weather/
    // zone risk all require a fresh GPS reading and go unavailable together
    // when the truck's position is stale, even if HOS/safety events are fine.
    dataSource: pilotDriver ? "real" : "mock",
    contextStatus,
    // dataCompleteness (N5, Phase 5, 2026-08-05): a plain live/total count
    // across all six DriverContext fields (including location, unlike
    // contextStatus's own five-field set) — see
    // lib/driverContext/contextStatus.ts::deriveDataCompleteness for the
    // full derivation and the documented caveat that its total (6) is not
    // the same denominator as contextStatus's own full_live/partial_live
    // computation. Deliberately not a confidence/accuracy/reliability
    // measure — see that function's doc comment.
    dataCompleteness,
    contextSources,
    liveData,
    hos: hosDetail,
    // Phase 1 — Real GPS: transparency-only breakdown, same relationship to
    // contextSources.location that `hos` above has to contextSources.hos.
    // speedMilesPerHour here is the same reading that now drives
    // DriverContext.speed / input.speed (Phase 4 — Real Speed data
    // pipeline; see lib/driverContext/assemble.ts::assembleSpeed). The
    // scoring formula itself (lib/riskEngine.ts::calcSpeedPenalty) is
    // unchanged this phase — only the input source changed.
    location: locationDetail,
    // Phase 2 — Weather from Real Vehicle GPS: transparency-only breakdown,
    // same relationship to contextSources.weather that `location` above has
    // to contextSources.location. latitude/longitude here are the
    // coordinates a weather request actually used (or was attempted with);
    // locationState/locationObservedAt explain *why* pilot weather is
    // unavailable when it is, without cross-referencing `location` above.
    weather: weatherDetail,
    // Phase 3 — Real Zone Risk: transparency-only breakdown, same
    // relationship to contextSources.zoneRisk that `weather` above has to
    // contextSources.weather, and gated on location the same way.
    // matchedZoneId/distanceMiles explain *why* a zone did or didn't match
    // without needing to cross-reference the zone dataset separately.
    zone: zoneDetail,
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

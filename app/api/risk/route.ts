import { NextRequest, NextResponse } from "next/server";
import { calculateRisk, resolveLevel } from "@/lib/riskEngine";
import { nextRunningAverage } from "@/lib/complianceScoreAverage";
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
import { shouldPersistDailyHistory } from "@/lib/riskPersistence";
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
  // Single source of truth for "may this call write daily historical Audit
  // records" — see lib/riskPersistence.ts. False for pilot drivers: their
  // history is now owned exclusively by the autonomous
  // lib/riskSampling/ pipeline (hourly SafetyScoreSample -> daily
  // DailySafetyScore/DailyDrivingSummary), never by this route. True for
  // demo (non-pilot) drivers, who have no autonomous collection pipeline —
  // Trip/ComplianceScore remain their only history source, unchanged from
  // before this correction.
  const persistDailyHistory = shouldPersistDailyHistory(pilotDriver);

  // getOrCreateTodayTrip is only needed for the demo (non-pilot) SafetyEvent
  // write below — a pilot driver must not get a Trip row created just from
  // opening the dashboard (that's exactly the app-open-creates-history
  // pattern this correction removes). /api/incident and /api/inspect still
  // call getOrCreateTodayTrip independently for real driver-initiated
  // events, for any driver — that is unaffected by this change.
  const [assembled, vehicle, tripId, summaryData] = await Promise.all([
    assembleDriverContext(driverId, pilotDriver),
    getDriverVehicleContext(driverId),
    persistDailyHistory ? getOrCreateTodayTrip(driverId) : Promise.resolve(null),
    fetchTodaySummaryData(driverId, pilotDriver),
  ]);

  const { context, liveData, hosDetail, locationDetail, weatherDetail, zoneDetail } = assembled;
  const input = toRiskInput(context);
  const contextSources = toContextSources(context);
  const contextStatus = deriveContextStatus(context);
  const dataCompleteness = deriveDataCompleteness(context);
  const result = calculateRisk(input);
  const alertsActive = result.factors.length;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  if (persistDailyHistory) {
    // Demo (non-pilot) only, from here through the SafetyEvent write below.
    // `tripId`/`today` are guaranteed non-null/defined in this branch —
    // persistDailyHistory is exactly the condition getOrCreateTodayTrip
    // above was called under.

    // Stamp current mileage and environmental snapshot on the active trip.
    // Updated on every call — mileage accumulates, conditions change.
    // `vehicle` (getDriverVehicleContext) is 100% mock scenario data for a
    // demo driver, the only case this branch runs under.
    await prisma.trip.update({
      where: { id: tripId! },
      data:  {
        ...(summaryData.milesDriven !== null ? { milesDriven: summaryData.milesDriven } : {}),
        weatherData: {
          weatherRisk:   vehicle.weatherRisk,
          zoneRisk:      vehicle.zoneRisk,
          locationLabel: vehicle.locationLabel,
          zoneName:      vehicle.zoneName,
        },
      },
    });

    // Persist one ComplianceScore row per driver per UTC calendar day, whose
    // `score` is a running arithmetic mean of every /api/risk calculation
    // that day (see lib/complianceScoreAverage.ts) — not just the first.
    // Race-safe without a large locking system: the day's first calculation
    // always attempts a plain create(); every later calculation (that or any
    // other concurrent request) hits the @@unique([driverId, date])
    // constraint, catches the P2002, and folds its score into the existing
    // row inside a transaction that takes a Postgres row lock
    // (`SELECT ... FOR UPDATE`) before computing the next average — so two
    // concurrent requests can never both read the same pre-update state and
    // silently drop one sample.
    try {
      await prisma.complianceScore.create({
        data: {
          driverId,
          date:          today,
          score:         result.score,
          sampleCount:   1,
          dangerLevel:   result.level,
          breakdownJson: result.factors as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      const isUniqueConstraintViolation =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!isUniqueConstraintViolation) throw err;

      await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ score: number; sampleCount: number }[]>`
          SELECT score, "sampleCount" FROM "ComplianceScore"
          WHERE "driverId" = ${driverId} AND date = ${today}
          FOR UPDATE
        `;
        const current = rows[0];
        // Row was just proven to exist by the P2002 above; nothing else
        // deletes ComplianceScore rows. Defensive only.
        if (!current) return;

        const { average, sampleCount } = nextRunningAverage(current.score, current.sampleCount, result.score);
        // breakdownJson intentionally left untouched here — it still
        // reflects the day's first calculation's factor breakdown, same
        // simplification this row already made before this change
        // (single-snapshot, not an aggregate). Averaging per-factor
        // breakdowns is out of scope.
        await tx.complianceScore.update({
          where: { driverId_date: { driverId, date: today } },
          data:  { score: average, sampleCount, dangerLevel: resolveLevel(average) },
        });
      });
    }

    // Persist today's safety events for non-pilot drivers only.
    // Pilot drivers: real events live in DriverEvent (via webhook pipeline) — no duplication.
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
            tripId: tripId!,
            eventType: ev.type,
            severity:  String(ev.severity),
            timestamp: now,
            lat:       vehicle.lat,
            lng:       vehicle.lng,
          })),
        });
      }
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

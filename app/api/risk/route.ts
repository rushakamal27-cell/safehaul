import { NextRequest, NextResponse } from "next/server";
import { calculateRisk } from "@/lib/riskEngine";
import { isPilotDriver } from "@/lib/driverEvents";
import { assembleDriverContext } from "@/lib/driverContext/assemble";
import { toRiskInput } from "@/lib/driverContext/toRiskInput";
import { toContextSources } from "@/lib/driverContext/toContextSources";
import { deriveContextStatus, deriveDataCompleteness } from "@/lib/driverContext/contextStatus";
import { fetchTodaySummaryData } from "@/lib/todaySummary";
import { isRiskScoreable } from "@/lib/riskScoreability";
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
  // Remove Implicit Demo Fallback (2026-10-08): pilot status is now the ONLY
  // thing this route needs to know about the driver. It no longer asks
  // whether a provider mapping exists at all, because nothing downstream
  // writes synthetic history any more — see this file's header.
  const pilotDriver = await isPilotDriver(driverId);

  const [assembled, summaryData] = await Promise.all([
    assembleDriverContext(driverId, pilotDriver),
    fetchTodaySummaryData(driverId, pilotDriver),
  ]);

  const { context, liveData, hosDetail, locationDetail, weatherDetail, zoneDetail } = assembled;
  const input = toRiskInput(context);
  const contextSources = toContextSources(context);
  const contextStatus = deriveContextStatus(context);
  const dataCompleteness = deriveDataCompleteness(context);
  // UNKNOWN != SAFE. toRiskInput substitutes neutral `?? 0` defaults for
  // missing fields, and calculateRisk cannot tell "measured zero risk" from
  // "measured nothing" — an entirely empty context scores 100/LOW/no factors
  // (asserted against the real engine in lib/__tests__/riskScoreability.test.ts).
  // So the score is withheld, not computed-then-hidden, whenever the context
  // was classified insufficient_context. This covers BOTH a user with no
  // active pilot mapping and an ACTIVE pilot whose GPS could not be resolved
  // this call: a real driver we cannot assess right now must not be told
  // they are safe either.
  const scoreable = isRiskScoreable(contextStatus);
  const result = scoreable ? calculateRisk(input) : null;

  // alertsActive counts risk factors, so with no score there are no factors
  // to count. Reported as unavailable rather than 0 — "no alerts" and "we
  // don't know whether there are alerts" must not render identically.
  const alertsActive = result ? result.factors.length : null;

  // Remove Implicit Demo Fallback (2026-10-08): the synthetic daily-history
  // block that used to live here is GONE for every driver.
  //
  // It ran for any driver with no provider mapping and wrote, on every single
  // dashboard open: a Trip row stamped with a MOCK mileage constant and a
  // mock weather/zone snapshot, a ComplianceScore whose `score` was the
  // running mean of scores computed from fabricated inputs, and SafetyEvent
  // rows invented from the driverId-hashed scenario. Those rows then flowed
  // into the Audit screen and were indistinguishable, in shape, from real
  // telematics history — the Trip row carrying 487 mock miles that started
  // this whole investigation was written by exactly this code.
  //
  // Nothing replaces it. Pilot drivers' history is owned by the autonomous
  // lib/riskSampling/ pipeline (hourly SafetyScoreSample -> daily
  // DailySafetyScore/DailyDrivingSummary); non-pilot drivers now have no
  // history, which is the correct amount of history to have for a driver we
  // have no data about. Opening the app is a read, and no longer writes
  // anything at all.
  //
  // Still untouched and still correct: /api/incident and /api/inspect call
  // getOrCreateTodayTrip independently for real driver-INITIATED events, for
  // any driver. Those are genuine user actions producing genuine records,
  // not fabrications, so they are out of scope here.

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
    // not). Kept for backward compatibility — do not rename/remove yet.
    // NOTE (Remove Implicit Demo Fallback, 2026-10-08): "mock" no longer
    // means the response CONTAINS mock data — it cannot any more. It now
    // means only "this driver has no active pilot mapping," and such a
    // response carries unavailable fields and result: null. The name is
    // retained to avoid breaking existing clients; prefer contextStatus.
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
        // Was hardcoded "available" — true only while a score always
        // existed. Now tracks whether there was a score to derive alerts
        // from (Remove Implicit Demo Fallback, 2026-10-08).
        alerts:   result ? "available" : "unavailable",
      },
    },
    input,
    result,
  });
}

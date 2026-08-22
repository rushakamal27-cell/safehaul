/**
 * lib/riskSampling/dailyFinalization.ts
 *
 * Part 3 + Part 4 — autonomous daily finalization. Runs shortly after a UTC
 * day ends (intended schedule: ~00:10 UTC, see
 * app/api/sync/daily-finalization/route.ts) and, for each active pilot
 * driver, creates AT MOST ONE DailySafetyScore and AT MOST ONE
 * DailyDrivingSummary row for the PREVIOUS UTC calendar day:
 *
 *   DailySafetyScore     <- arithmetic mean of that day's SafetyScoreSample
 *                           rows (lib/riskSampling/dailyAverage.ts) — never
 *                           divided by an assumed 24; the real sample count
 *                           is the denominator, always.
 *   DailyDrivingSummary  <- earliest/latest moving DriverObservation that
 *                           day (lib/riskSampling/routeSpan.ts), real
 *                           Samsara odometer delta for mileage, and daily
 *                           means of DriverObservation.weatherRisk/zoneRisk.
 *
 * Immutable once created: both writes are atomic create()s; a unique-
 * constraint violation on a rerun (same driver, same day) means "already
 * finalized" and is treated as a skip, never an update — see each driver's
 * write helpers below. A day with zero valid SafetyScoreSample rows gets no
 * DailySafetyScore row at all (never a fabricated 0); a day with zero
 * DriverObservation rows gets no DailyDrivingSummary row at all.
 */

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma";
import { resolveCurrentVehicleId } from "@/lib/providers/samsara/vehicleId";
import { fetchVehicleOdometerReadings, odometerDeltaMiles } from "@/lib/providers/samsara/vehicleStats";
import { utcPreviousDayBounds } from "./dayBounds";
import { computeDailyAverage } from "./dailyAverage";
import { deriveRouteSpan, type ObservationForRouteSpan } from "./routeSpan";
import { resolveLevel } from "@/lib/riskEngine";

const MILEAGE_FETCH_TIMEOUT_MS = 8_000;
/** Nominal hourly slots per day — informational only (DailySafetyScore.expectedSampleCount), never used as an averaging denominator. See dailyAverage.ts. */
const EXPECTED_HOURLY_SAMPLES_PER_DAY = 24;

export interface PilotDriverIdClient {
  findMany(args: {
    where: { isPilot: true; isActive: true };
    select: { driverId: true };
    distinct: ["driverId"];
  }): Promise<Array<{ driverId: string }>>;
}

export interface SafetyScoreSampleAggClient {
  findMany(args: {
    where: { driverId: string; hourBucket: { gte: Date; lt: Date } };
    select: { score: true };
  }): Promise<Array<{ score: number }>>;
}

export interface DailySafetyScoreClient {
  findUnique(args: {
    where: { driverId_date: { driverId: string; date: Date } };
    select: { id: true };
  }): Promise<{ id: string } | null>;
  create(args: { data: Prisma.DailySafetyScoreUncheckedCreateInput }): Promise<{ id: string }>;
}

interface ObservationRow {
  observedAt: Date;
  latitude: number | null;
  longitude: number | null;
  speedMph: number | null;
  weatherRisk: number | null;
  zoneRisk: number | null;
  contextJson: Prisma.JsonValue;
}

export interface DriverObservationAggClient {
  findMany(args: {
    where: { driverId: string; observedAt: { gte: Date; lt: Date } };
    select: {
      observedAt: true;
      latitude: true;
      longitude: true;
      speedMph: true;
      weatherRisk: true;
      zoneRisk: true;
      contextJson: true;
    };
  }): Promise<ObservationRow[]>;
}

export interface DailyDrivingSummaryClient {
  findUnique(args: {
    where: { driverId_date: { driverId: string; date: Date } };
    select: { id: true };
  }): Promise<{ id: string } | null>;
  create(args: { data: Prisma.DailyDrivingSummaryUncheckedCreateInput }): Promise<{ id: string }>;
}

export interface DailyFinalizationDeps {
  pilotDriverIdClient?: PilotDriverIdClient;
  scoreSampleClient?: SafetyScoreSampleAggClient;
  dailyScoreClient?: DailySafetyScoreClient;
  observationClient?: DriverObservationAggClient;
  drivingSummaryClient?: DailyDrivingSummaryClient;
  now?: () => Date;
  resolveVehicleId?: typeof resolveCurrentVehicleId;
  fetchOdometerReadings?: typeof fetchVehicleOdometerReadings;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function resolvePilotDriverIds(deps: DailyFinalizationDeps): Promise<string[]> {
  const client = deps.pilotDriverIdClient ?? prisma.driverProviderMapping;
  const mappings = await client.findMany({
    where: { isPilot: true, isActive: true },
    select: { driverId: true },
    distinct: ["driverId"],
  });
  return mappings.map((m) => m.driverId);
}

export type DailySafetyScoreOutcome =
  | { status: "created"; id: string }
  | { status: "skipped"; reason: "already_finalized" | "no_samples" };

/** `dayStart` doubles as the DailySafetyScore.date bucket key — the UTC day's midnight instant, same convention legacy ComplianceScore.date already used. */
async function finalizeDailySafetyScore(
  driverId: string,
  dayStart: Date,
  dayEnd: Date,
  deps: DailyFinalizationDeps
): Promise<DailySafetyScoreOutcome> {
  const dailyScoreClient = deps.dailyScoreClient ?? prisma.dailySafetyScore;
  const scoreSampleClient = deps.scoreSampleClient ?? prisma.safetyScoreSample;

  const existing = await dailyScoreClient.findUnique({
    where: { driverId_date: { driverId, date: dayStart } },
    select: { id: true },
  });
  if (existing) return { status: "skipped", reason: "already_finalized" };

  const samples = await scoreSampleClient.findMany({
    where: { driverId, hourBucket: { gte: dayStart, lt: dayEnd } },
    select: { score: true },
  });
  const daily = computeDailyAverage(samples.map((s) => s.score));
  if (!daily) return { status: "skipped", reason: "no_samples" };

  try {
    const created = await dailyScoreClient.create({
      data: {
        driverId,
        date: dayStart,
        averageScore: daily.average,
        sampleCount: daily.sampleCount,
        expectedSampleCount: EXPECTED_HOURLY_SAMPLES_PER_DAY,
        dangerLevel: resolveLevel(daily.average),
      },
    });
    return { status: "created", id: created.id };
  } catch (err) {
    // Another finalization run for the same (driverId, date) won the race —
    // already finalized, never updated. See file header.
    if (isUniqueConstraintViolation(err)) return { status: "skipped", reason: "already_finalized" };
    throw err;
  }
}

function toRouteSpanObservation(row: ObservationRow): ObservationForRouteSpan {
  const location =
    row.contextJson && typeof row.contextJson === "object" && !Array.isArray(row.contextJson)
      ? (row.contextJson as Record<string, unknown>).location
      : null;
  const formattedLocation =
    location && typeof location === "object" && !Array.isArray(location)
      ? (location as Record<string, unknown>).formattedLocation
      : null;
  return {
    observedAt: row.observedAt,
    latitude: row.latitude,
    longitude: row.longitude,
    speedMph: row.speedMph,
    locationLabel: typeof formattedLocation === "string" ? formattedLocation : null,
  };
}

async function resolveDailyMileage(
  driverId: string,
  dayStart: Date,
  dayEnd: Date,
  deps: DailyFinalizationDeps
): Promise<number | null> {
  const resolveVehicleId = deps.resolveVehicleId ?? resolveCurrentVehicleId;
  const fetchOdometerReadings = deps.fetchOdometerReadings ?? fetchVehicleOdometerReadings;

  const { vehicleId } = await resolveVehicleId(driverId);
  if (!vehicleId) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MILEAGE_FETCH_TIMEOUT_MS);
  try {
    const readings = await fetchOdometerReadings({
      vehicleId,
      startTimeIso: dayStart.toISOString(),
      endTimeIso: dayEnd.toISOString(),
      signal: controller.signal,
    });
    return odometerDeltaMiles(readings);
  } catch (err) {
    console.error(
      `[daily-finalization] Odometer fetch failed for driverId="${driverId}":`,
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export type DailyDrivingSummaryOutcome =
  | { status: "created"; id: string }
  | { status: "skipped"; reason: "already_finalized" | "no_observations" };

/** `dayStart` doubles as the DailyDrivingSummary.date bucket key, same convention as finalizeDailySafetyScore. */
async function finalizeDailyDrivingSummary(
  driverId: string,
  dayStart: Date,
  dayEnd: Date,
  deps: DailyFinalizationDeps
): Promise<DailyDrivingSummaryOutcome> {
  const drivingSummaryClient = deps.drivingSummaryClient ?? prisma.dailyDrivingSummary;
  const observationClient = deps.observationClient ?? prisma.driverObservation;

  const existing = await drivingSummaryClient.findUnique({
    where: { driverId_date: { driverId, date: dayStart } },
    select: { id: true },
  });
  if (existing) return { status: "skipped", reason: "already_finalized" };

  const observations = await observationClient.findMany({
    where: { driverId, observedAt: { gte: dayStart, lt: dayEnd } },
    select: {
      observedAt: true,
      latitude: true,
      longitude: true,
      speedMph: true,
      weatherRisk: true,
      zoneRisk: true,
      contextJson: true,
    },
  });
  if (observations.length === 0) return { status: "skipped", reason: "no_observations" };

  const routeSpan = deriveRouteSpan(observations.map(toRouteSpanObservation));
  const weatherDaily = computeDailyAverage(
    observations.map((o) => o.weatherRisk).filter((v): v is number => v !== null)
  );
  const zoneDaily = computeDailyAverage(
    observations.map((o) => o.zoneRisk).filter((v): v is number => v !== null)
  );
  const milesDriven = await resolveDailyMileage(driverId, dayStart, dayEnd, deps);

  try {
    const created = await drivingSummaryClient.create({
      data: {
        driverId,
        date: dayStart,
        startLatitude: routeSpan.start?.latitude ?? null,
        startLongitude: routeSpan.start?.longitude ?? null,
        startLocationLabel: routeSpan.start?.locationLabel ?? null,
        startObservedAt: routeSpan.start?.observedAt ?? null,
        endLatitude: routeSpan.end?.latitude ?? null,
        endLongitude: routeSpan.end?.longitude ?? null,
        endLocationLabel: routeSpan.end?.locationLabel ?? null,
        endObservedAt: routeSpan.end?.observedAt ?? null,
        routeSpanAvailable: routeSpan.available,
        milesDriven: milesDriven,
        weatherRiskAvg: weatherDaily?.average ?? null,
        weatherSampleCount: weatherDaily?.sampleCount ?? 0,
        zoneRiskAvg: zoneDaily?.average ?? null,
        zoneSampleCount: zoneDaily?.sampleCount ?? 0,
      },
    });
    return { status: "created", id: created.id };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) return { status: "skipped", reason: "already_finalized" };
    throw err;
  }
}

export interface DailyFinalizationDriverResult {
  driverId: string;
  safetyScore: DailySafetyScoreOutcome | { status: "failed"; reason: string };
  drivingSummary: DailyDrivingSummaryOutcome | { status: "failed"; reason: string };
}

export interface DailyFinalizationResult {
  date: string;
  driversConsidered: number;
  results: DailyFinalizationDriverResult[];
}

/**
 * Finalizes the previous UTC day for every active pilot driver. Each
 * driver's two writes (safety score, driving summary) are independently
 * try/caught so one driver's failure — or one write's failure — never
 * aborts the rest of the run, same failure-isolation pattern as
 * baselineObservationSync.ts/pilotObservationCycle.ts.
 */
export async function runDailyFinalization(
  deps: DailyFinalizationDeps = {}
): Promise<DailyFinalizationResult> {
  const now = deps.now ?? (() => new Date());
  const { start: dayStart, end: dayEnd } = utcPreviousDayBounds(now());

  const pilotDriverIds = await resolvePilotDriverIds(deps);
  const results: DailyFinalizationDriverResult[] = [];

  for (const driverId of pilotDriverIds) {
    let safetyScore: DailyFinalizationDriverResult["safetyScore"];
    try {
      safetyScore = await finalizeDailySafetyScore(driverId, dayStart, dayEnd, deps);
    } catch (err) {
      console.error(`[daily-finalization] Safety score finalization failed for driverId="${driverId}":`, err);
      safetyScore = { status: "failed", reason: err instanceof Error ? err.message : "Unknown error" };
    }

    let drivingSummary: DailyFinalizationDriverResult["drivingSummary"];
    try {
      drivingSummary = await finalizeDailyDrivingSummary(driverId, dayStart, dayEnd, deps);
    } catch (err) {
      console.error(`[daily-finalization] Driving summary finalization failed for driverId="${driverId}":`, err);
      drivingSummary = { status: "failed", reason: err instanceof Error ? err.message : "Unknown error" };
    }

    results.push({ driverId, safetyScore, drivingSummary });
  }

  return { date: dayStart.toISOString(), driversConsidered: pilotDriverIds.length, results };
}

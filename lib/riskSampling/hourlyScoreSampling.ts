/**
 * lib/riskSampling/hourlyScoreSampling.ts
 *
 * Part 2 — autonomous derived hourly Safety Score collector. For each
 * active pilot driver, at most once per UTC clock hour, assembles the SAME
 * trusted DriverContext /api/risk uses, runs the SAME calculateRisk() risk
 * engine (unchanged formula/weights), and persists exactly one
 * SafetyScoreSample row for that (driver, hour). Never invoked by /api/risk
 * or any app-open path — intended for an autonomous Supabase Cron job (see
 * app/api/sync/hourly-score-sample/route.ts), same CRON_SECRET/lock pattern
 * already established by Phase 6B/6C.
 *
 * Idempotency, not averaging: unlike ComplianceScore's running mean, a
 * second attempt for an hour that already has a sample is a plain skip —
 * "at most one sample per driver/hour" (Part 2), never a fold-in. The
 * @@unique([driverId, hourBucket]) constraint is the actual source of
 * truth; the pre-check below (query before compute) is only an optimization
 * to avoid an unnecessary Samsara/OpenWeatherMap round-trip on the common
 * (already-sampled) path, matching baselineObservationSync.ts's own
 * recency-guard-before-provider-call ordering.
 *
 * Missing/partial context is never a reason to skip a sample: /api/risk
 * itself never blocks scoring on incomplete context (see
 * lib/driverContext/toRiskInput.ts's neutral-default rules), so a hourly
 * sample mirrors that exactly. What's preserved instead is provenance —
 * `contextStatus` (full_live/partial_live/demo) and a compact
 * `breakdownJson` snapshot (factors + contextSources) — reusing
 * lib/driverContext/contextStatus.ts and toContextSources.ts verbatim
 * rather than inventing a new provenance vocabulary.
 */

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma";
import { assembleDriverContext } from "@/lib/driverContext/assemble";
import { toRiskInput } from "@/lib/driverContext/toRiskInput";
import { toContextSources } from "@/lib/driverContext/toContextSources";
import { deriveContextStatus } from "@/lib/driverContext/contextStatus";
import { calculateRisk } from "@/lib/riskEngine";
import { utcHourBucket } from "./dayBounds";

/** Minimal slice of the Prisma DriverProviderMapping delegate this module needs — same shape as baselineObservationSync.ts's PilotDriverIdClient. */
export interface PilotDriverIdClient {
  findMany(args: {
    where: { isPilot: true; isActive: true };
    select: { driverId: true };
    distinct: ["driverId"];
  }): Promise<Array<{ driverId: string }>>;
}

export interface SafetyScoreSampleClient {
  findUnique(args: {
    where: { driverId_hourBucket: { driverId: string; hourBucket: Date } };
    select: { id: true };
  }): Promise<{ id: string } | null>;
  create(args: { data: Prisma.SafetyScoreSampleUncheckedCreateInput }): Promise<{ id: string }>;
}

export type HourlyScoreSampleDriverResult =
  | { driverId: string; status: "created"; sampleId: string }
  | { driverId: string; status: "skipped"; reason: "already_sampled" }
  | { driverId: string; status: "failed"; reason: string };

export interface HourlyScoreSamplingResult {
  hourBucket: string;
  driversConsidered: number;
  created: number;
  skipped: number;
  failed: number;
  results: HourlyScoreSampleDriverResult[];
}

export interface HourlyScoreSamplingDeps {
  pilotDriverIdClient?: PilotDriverIdClient;
  sampleClient?: SafetyScoreSampleClient;
  now?: () => Date;
  assembleDriverContextFn?: typeof assembleDriverContext;
}

async function resolvePilotDriverIds(deps: HourlyScoreSamplingDeps): Promise<string[]> {
  const client = deps.pilotDriverIdClient ?? prisma.driverProviderMapping;
  const mappings = await client.findMany({
    where: { isPilot: true, isActive: true },
    select: { driverId: true },
    distinct: ["driverId"],
  });
  return mappings.map((m) => m.driverId);
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function processDriver(
  driverId: string,
  hourBucket: Date,
  deps: HourlyScoreSamplingDeps
): Promise<HourlyScoreSampleDriverResult> {
  const sampleClient = deps.sampleClient ?? prisma.safetyScoreSample;

  const existing = await sampleClient.findUnique({
    where: { driverId_hourBucket: { driverId, hourBucket } },
    select: { id: true },
  });
  if (existing) return { driverId, status: "skipped", reason: "already_sampled" };

  const assembleFn = deps.assembleDriverContextFn ?? assembleDriverContext;
  const assembled = await assembleFn(driverId, true);
  const input = toRiskInput(assembled.context);
  const contextSources = toContextSources(assembled.context);
  const contextStatus = deriveContextStatus(assembled.context);
  const result = calculateRisk(input);

  try {
    const created = await sampleClient.create({
      data: {
        driverId,
        hourBucket,
        score: result.score,
        dangerLevel: result.level,
        contextStatus,
        breakdownJson: { factors: result.factors, contextSources } as unknown as Prisma.InputJsonValue,
        sampledAt: new Date(assembled.calculatedAt),
      },
    });
    return { driverId, status: "created", sampleId: created.id };
  } catch (err) {
    // A concurrent invocation raced this same (driverId, hourBucket) slot
    // and won — not a failure, matches this codebase's established
    // create()-then-P2002-fallback idiom, except here there is nothing to
    // fold into: the row already IS this hour's one sample.
    if (isUniqueConstraintViolation(err)) {
      return { driverId, status: "skipped", reason: "already_sampled" };
    }
    throw err;
  }
}

export async function runHourlyScoreSampling(
  deps: HourlyScoreSamplingDeps = {}
): Promise<HourlyScoreSamplingResult> {
  const now = deps.now ?? (() => new Date());
  const hourBucket = utcHourBucket(now());

  const pilotDriverIds = await resolvePilotDriverIds(deps);
  const results: HourlyScoreSampleDriverResult[] = [];

  for (const driverId of pilotDriverIds) {
    try {
      results.push(await processDriver(driverId, hourBucket, deps));
    } catch (err) {
      console.error(`[hourly-score-sampling] Failed to sample driverId="${driverId}":`, err);
      results.push({ driverId, status: "failed", reason: "sampling_failed" });
    }
  }

  return {
    hourBucket: hourBucket.toISOString(),
    driversConsidered: pilotDriverIds.length,
    created: results.filter((r) => r.status === "created").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}

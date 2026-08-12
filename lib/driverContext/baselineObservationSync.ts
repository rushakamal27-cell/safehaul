/**
 * lib/driverContext/baselineObservationSync.ts
 *
 * Phase 6B.3 — orchestrates one baseline (triggerType: "interval")
 * DriverObservation capture cycle across all active pilot drivers. Called
 * from GET /api/sync/driver-observations (CRON_SECRET-gated, manual-only —
 * no cron wiring exists yet, see that route's file header). Extracted into
 * its own function per this codebase's route → service/helper → DB
 * convention (mirrors lib/providers/samsara/syncSafetyEvents.ts's
 * relationship to its route).
 *
 * Per-driver order (deliberately in this sequence to avoid unnecessary
 * provider calls — see the file's Phase 6B.3 design discussion):
 *   1. Check the driver's most recent triggerType="interval" observation.
 *      If it's within BASELINE_INTERVAL_MS, skip — no provider call at all.
 *   2. Otherwise, build a snapshot (this is what actually calls Samsara/
 *      OpenWeatherMap/HOS, via the same collector Phase 6B.2 already ships).
 *   3. Inspect the snapshot's location freshness. Only a genuinely "fresh"
 *      reading (the same three-state LocationState this codebase already
 *      uses to decide whether a position is a trustworthy proxy for "where
 *      is the truck right now" — see lib/driverContext/types.ts) may be
 *      persisted as a baseline row. Stale/unavailable locations are
 *      discarded, not persisted with nulled-out fields — a baseline
 *      observation implicitly claims "the vehicle was live at this moment,"
 *      which a stale/unavailable location can't support.
 *   4. Persist only if step 3 passed.
 *
 * Each driver is processed independently and sequentially; one driver's
 * failure is caught, recorded, and never aborts the rest of the run.
 */

import { prisma } from "@/lib/prisma";
import { isPilotDriver } from "@/lib/driverEvents";
import {
  buildDriverObservationSnapshot,
  persistDriverObservationSnapshot,
  type CaptureDriverObservationDeps,
  type DriverObservationSnapshot,
} from "./captureObservation";

/**
 * Target baseline cadence — one shared constant, not cron-specific (this
 * value has nothing to do with how often anything is actually invoked; it
 * only governs how recent an existing observation must be to skip a new
 * one). See the Phase 6B design writeup for why 10 minutes was chosen.
 */
export const BASELINE_INTERVAL_MS = 10 * 60 * 1000;

export type BaselineObservationSkipReason =
  | "recent_observation"
  | "location_not_fresh"
  | "not_eligible";

export type BaselineObservationDriverResult =
  | { driverId: string; status: "created"; observationId: string }
  | { driverId: string; status: "skipped"; reason: BaselineObservationSkipReason }
  | { driverId: string; status: "failed"; reason: string };

export interface BaselineObservationSyncResult {
  driversConsidered: number;
  created: number;
  skipped: number;
  failed: number;
  results: BaselineObservationDriverResult[];
}

/** Minimal slice of the Prisma DriverProviderMapping delegate this module needs — narrow enough to fake in tests, same pattern as PilotMappingClient in syncSafetyEvents.ts. */
export interface PilotDriverIdClient {
  findMany(args: {
    where: { isPilot: true; isActive: true };
    select: { driverId: true };
    distinct: ["driverId"];
  }): Promise<Array<{ driverId: string }>>;
}

/** Minimal slice of the Prisma DriverObservation delegate this module needs for the recency guard — separate from CaptureDriverObservationDeps.observationClient (create-only). */
export interface RecentObservationClient {
  findFirst(args: {
    where: { driverId: string; triggerType: "interval" };
    orderBy: { observedAt: "desc" };
    select: { observedAt: true };
  }): Promise<{ observedAt: Date } | null>;
}

export interface BaselineObservationSyncDeps {
  pilotDriverIdClient?: PilotDriverIdClient;
  recentObservationClient?: RecentObservationClient;
  isPilotDriver?: (driverId: string) => Promise<boolean>;
  now?: () => Date;
  /** Passed through to buildDriverObservationSnapshot/persistDriverObservationSnapshot — lets tests fake provider calls and DB writes without touching the guard/orchestration logic above. */
  captureDeps?: CaptureDriverObservationDeps;
}

async function resolvePilotDriverIds(deps: BaselineObservationSyncDeps): Promise<string[]> {
  const client = deps.pilotDriverIdClient ?? prisma.driverProviderMapping;
  const mappings = await client.findMany({
    where: { isPilot: true, isActive: true },
    select: { driverId: true },
    distinct: ["driverId"],
  });
  return mappings.map((m) => m.driverId);
}

/** True if the driver's most recent interval observation (if any) is younger than BASELINE_INTERVAL_MS. */
async function hasRecentIntervalObservation(
  driverId: string,
  deps: BaselineObservationSyncDeps,
  nowMs: number
): Promise<boolean> {
  const client = deps.recentObservationClient ?? prisma.driverObservation;
  const latest = await client.findFirst({
    where: { driverId, triggerType: "interval" },
    orderBy: { observedAt: "desc" },
    select: { observedAt: true },
  });
  if (!latest) return false;
  return nowMs - latest.observedAt.getTime() < BASELINE_INTERVAL_MS;
}

function isLocationFresh(snapshot: DriverObservationSnapshot): boolean {
  return snapshot.contextJson.location.state === "fresh";
}

async function processDriver(
  driverId: string,
  deps: BaselineObservationSyncDeps,
  nowMs: number,
  nowFn: () => Date
): Promise<BaselineObservationDriverResult> {
  // Defensive re-check, same pattern syncSafetyEvents.ts's processPage uses
  // for its own pilot mapping ("may have been deactivated between the
  // prefetch and now") — the driver list was resolved once at the top of
  // the run, so guard against a mapping changing mid-run.
  const isPilotFn = deps.isPilotDriver ?? isPilotDriver;
  if (!(await isPilotFn(driverId))) {
    return { driverId, status: "skipped", reason: "not_eligible" };
  }

  // Step 1 — cheap DB-only check BEFORE any provider call.
  if (await hasRecentIntervalObservation(driverId, deps, nowMs)) {
    return { driverId, status: "skipped", reason: "recent_observation" };
  }

  // Step 2 — build the snapshot (this is what actually calls providers).
  // The orchestrator's own clock (deps.now, defaulting to real time) is
  // threaded through as the collector's clock too — unless the caller
  // already pinned a more specific one on captureDeps — so a single `now`
  // deps.now injection keeps the recency guard and the snapshot's own
  // observedAt/collectedAt consistent with each other (matters for tests;
  // in production both default to the real clock regardless).
  const snapshot = await buildDriverObservationSnapshot(
    { driverId, triggerType: "interval" },
    { now: nowFn, ...deps.captureDeps }
  );

  // Step 3 — only a genuinely fresh location may back a baseline row.
  if (!isLocationFresh(snapshot)) {
    return { driverId, status: "skipped", reason: "location_not_fresh" };
  }

  // Step 4 — persist.
  const created = await persistDriverObservationSnapshot(snapshot, deps.captureDeps);
  return { driverId, status: "created", observationId: created.id };
}

export async function runBaselineObservationSync(
  deps: BaselineObservationSyncDeps = {}
): Promise<BaselineObservationSyncResult> {
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();

  const pilotDriverIds = await resolvePilotDriverIds(deps);

  const results: BaselineObservationDriverResult[] = [];
  for (const driverId of pilotDriverIds) {
    try {
      results.push(await processDriver(driverId, deps, nowMs, now));
    } catch (err) {
      // One driver's failure must never abort the rest of the run. Full
      // error (may include provider response detail) is logged server-side
      // only — the returned reason is a safe, generic label.
      console.error(`[baseline-observation-sync] Failed to capture observation for driverId="${driverId}":`, err);
      results.push({ driverId, status: "failed", reason: "capture_failed" });
    }
  }

  return {
    driversConsidered: pilotDriverIds.length,
    created: results.filter((r) => r.status === "created").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}

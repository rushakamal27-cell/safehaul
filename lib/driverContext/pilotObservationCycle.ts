/**
 * lib/driverContext/pilotObservationCycle.ts
 *
 * Phase 6B.6 — the combined hybrid pilot observation cycle: Safety Events
 * sync (with its existing Phase 6B.4 enrichment) followed by baseline
 * interval observation capture, as ONE orchestration path intended for a
 * single periodic scheduler entry (once enabled — see
 * app/api/sync/pilot-observation-cycle/route.ts's file header for whether
 * that has actually happened yet).
 *
 * Reuses, never duplicates:
 *   - lib/providers/samsara/syncLock.ts::withSamsaraSyncLock — the SAME
 *     shared Safety Events lock every other caller uses (on-demand /api/risk,
 *     the standalone Safety Events ops route).
 *   - lib/providers/samsara/syncSafetyEvents.ts::runSamsaraSafetyEventsSync
 *     — including its own Phase 6B.4 enrichment step, unchanged.
 *   - lib/driverContext/baselineObservationSync.ts::runBaselineObservationSync
 *     — including its existing 10-minute BASELINE_INTERVAL_MS recency guard
 *     and fresh-location gate, unchanged.
 *
 * Two separate locks, deliberately non-blocking, no deadlock risk:
 *   1. THE JOB LOCK (this module) — key {provider: "samsara",
 *      streamKey: "pilot-observation-cycle"} on the SAME ProviderSyncState
 *      table, via the SAME withProviderSyncLock primitive, but a DIFFERENT
 *      row than the Safety Events lock. Ensures at most one hybrid cycle
 *      performs baseline work at a time — this is what closes the
 *      check-then-create race in the baseline route's recency guard
 *      (Phase 6B.5's open finding) WITHOUT inventing a DB uniqueness model
 *      for interval rows: two concurrent scheduler invocations now cannot
 *      both reach runBaselineObservationSync at all.
 *   2. THE SAFETY EVENTS LOCK (lib/providers/samsara/syncLock.ts) — a
 *      SEPARATE row, attempted from INSIDE the job lock's `run` callback.
 *
 *   Why this ordering can never deadlock: both locks are claimed with a
 *   single non-blocking attempt each (INSERT-or-atomic-UPDATE, resolving
 *   immediately to acquired/sync_in_progress — see
 *   lib/providerSyncLock.ts) — neither lock ever WAITS or retries while
 *   holding the other. A classic deadlock requires two processes each
 *   blocked waiting on a resource the other already holds; since nothing
 *   here ever blocks (a failed claim returns instantly), that condition
 *   cannot arise regardless of acquisition order. The job lock is taken
 *   first only because it's the OUTER concern (one cycle at a time); the
 *   Safety Events lock underneath answers a narrower, independent question
 *   (is a drain already running system-wide, cycle or not) and is safe to
 *   attempt — and safe to lose — every single time.
 *
 * Failure isolation, by construction:
 *   - Safety Events sync_in_progress/failed/threw → baseline is still
 *     attempted regardless (see runCycleBody below) — an unrelated
 *     concurrent Safety Events sync (e.g. from /api/risk) must never
 *     suppress a due baseline capture.
 *   - A driver's own baseline failure, HOS-unavailable, weather-unavailable,
 *     or a not-fresh location are ALL already handled by
 *     runBaselineObservationSync/its collector (Phase 6B.2/6B.3) —
 *     unchanged, nothing new needed here.
 *   - runBaselineObservationSync's own resolvePilotDriverIds has no
 *     internal try/catch around its DB read — wrapped here so a baseline-
 *     side DB failure can never retroactively affect an already-computed,
 *     successful Safety Events result.
 */

import {
  withProviderSyncLock,
  type ProviderSyncStateClient,
} from "@/lib/providerSyncLock";
import {
  withSamsaraSyncLock,
  type WithSamsaraSyncLockDeps,
} from "@/lib/providers/samsara/syncLock";
import type { SamsaraSyncOutcome } from "@/lib/providers/samsara/syncSafetyEvents";
import {
  runBaselineObservationSync,
  type BaselineObservationSyncDeps,
  type BaselineObservationSyncResult,
} from "./baselineObservationSync";

const JOB_LOCK_KEY = { provider: "samsara", streamKey: "pilot-observation-cycle" } as const;

export type SafetyEventsCycleResult =
  | {
      status: "synced";
      driverEventsCreated: number;
      newDriverEventIds: string[];
      enrichmentAttempted: number;
      enrichmentCreated: number;
      enrichmentSkipped: number;
      enrichmentFailed: number;
    }
  | { status: "sync_in_progress" }
  | { status: "failed"; error: string }
  | { status: "no_pilot_drivers" };

export type BaselineCycleResult =
  | ({ status: "completed" } & BaselineObservationSyncResult)
  | { status: "failed"; error: string };

export type PilotObservationCycleResult =
  | { ok: true; cycleStatus: "completed"; safetyEvents: SafetyEventsCycleResult; baseline: BaselineCycleResult }
  | { ok: true; cycleStatus: "cycle_in_progress" }
  | { ok: false; cycleStatus: "lock_error"; error: string };

export interface PilotObservationCycleDeps {
  /** Injectable for tests; defaults to the real Prisma delegate. Governs the job-level (pilot-observation-cycle) lock. */
  jobLockClient?: ProviderSyncStateClient;
  /** Passed through to withSamsaraSyncLock for the Safety Events portion. */
  safetyEventsLockDeps?: WithSamsaraSyncLockDeps;
  /** Passed through to runBaselineObservationSync for the baseline portion. */
  baselineDeps?: BaselineObservationSyncDeps;
}

function mapSafetyEventsResult(
  lockResult: Awaited<ReturnType<typeof withSamsaraSyncLock>>
): SafetyEventsCycleResult {
  switch (lockResult.status) {
    case "sync_in_progress":
      return { status: "sync_in_progress" };
    case "lock_acquire_failed":
      return { status: "failed", error: "Failed to acquire Safety Events sync lock" };
    case "sync_threw":
      return { status: "failed", error: lockResult.error };
    case "acquired": {
      const outcome: SamsaraSyncOutcome = lockResult.outcome;
      if (!outcome.synced) {
        return { status: "failed", error: outcome.error };
      }
      if (outcome.skipped) {
        return { status: "no_pilot_drivers" };
      }
      return {
        status: "synced",
        driverEventsCreated: outcome.driverEventsCreated,
        newDriverEventIds: outcome.newDriverEventIds,
        enrichmentAttempted: outcome.enrichment.enrichmentAttempted,
        enrichmentCreated: outcome.enrichment.enrichmentCreated,
        enrichmentSkipped: outcome.enrichment.enrichmentSkipped,
        enrichmentFailed: outcome.enrichment.enrichmentFailed,
      };
    }
  }
}

async function runCycleBody(deps: PilotObservationCycleDeps): Promise<{
  safetyEvents: SafetyEventsCycleResult;
  baseline: BaselineCycleResult;
}> {
  // Step 1 — Safety Events, through the shared lock. Never throws (see
  // withSamsaraSyncLock's own contract) but guarded anyway for defense in
  // depth, matching this phase's failure-isolation goal.
  let safetyEvents: SafetyEventsCycleResult;
  try {
    const lockResult = await withSamsaraSyncLock(deps.safetyEventsLockDeps);
    safetyEvents = mapSafetyEventsResult(lockResult);
  } catch (err) {
    console.error("[pilot-observation-cycle] Safety Events step threw unexpectedly:", err);
    safetyEvents = { status: "failed", error: err instanceof Error ? err.message : "Unknown error" };
  }

  // Step 2 — baseline, attempted regardless of the Safety Events outcome
  // above (sync_in_progress or failed must not suppress a due baseline
  // capture — see file header). runBaselineObservationSync's own
  // resolvePilotDriverIds has no internal try/catch, so this guard is what
  // stops a baseline-side DB failure from ever affecting the
  // already-computed safetyEvents result above.
  let baseline: BaselineCycleResult;
  try {
    const result = await runBaselineObservationSync(deps.baselineDeps);
    baseline = { status: "completed", ...result };
  } catch (err) {
    console.error("[pilot-observation-cycle] Baseline step threw unexpectedly:", err);
    baseline = { status: "failed", error: err instanceof Error ? err.message : "Unknown error" };
  }

  return { safetyEvents, baseline };
}

/**
 * Runs the combined hybrid pilot observation cycle under the job-level
 * lock. Two concurrent invocations of this function → exactly one performs
 * the cycle body; the other resolves immediately to cycleStatus:
 * "cycle_in_progress" without touching Safety Events or baseline at all.
 */
export async function runPilotObservationCycle(
  deps: PilotObservationCycleDeps = {}
): Promise<PilotObservationCycleResult> {
  const jobLockResult = await withProviderSyncLock({
    key: JOB_LOCK_KEY,
    client: deps.jobLockClient,
    // No timeoutMs — the cycle's own two steps (Safety Events sync, then
    // baseline) may legitimately need to run to completion, same reasoning
    // as the standalone ops routes (see syncLock.ts's file header).
    run: () => runCycleBody(deps),
  });

  switch (jobLockResult.status) {
    case "acquired":
      return { ok: true, cycleStatus: "completed", ...jobLockResult.result };
    case "sync_in_progress":
      return { ok: true, cycleStatus: "cycle_in_progress" };
    case "lock_acquire_failed":
      return { ok: false, cycleStatus: "lock_error", error: "Failed to acquire pilot-observation-cycle lock" };
    case "threw":
      // runCycleBody itself is guarded (see above) and should never throw,
      // but this branch exists so the type remains exhaustive and honest
      // about what withProviderSyncLock's contract actually allows.
      return { ok: false, cycleStatus: "lock_error", error: jobLockResult.error };
  }
}

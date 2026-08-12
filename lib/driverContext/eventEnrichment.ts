/**
 * lib/driverContext/eventEnrichment.ts
 *
 * Phase 6B.4 — best-effort DriverObservation enrichment for newly created
 * DriverEvent rows. Provider-neutral: takes plain {id, driverId} pairs, not
 * anything Samsara-specific, so any future provider's own sync could reuse
 * this the same way lib/providers/samsara/syncSafetyEvents.ts does.
 *
 * Strictly best-effort, strictly after the fact. This is only ever called
 * once the caller's OWN ingestion has already fully succeeded and persisted
 * its DriverEvent rows — nothing in here can affect whether that ingestion
 * is considered successful. Every failure mode below (idempotency check,
 * the capture itself) is caught per-event and turned into a stat, never a
 * thrown error that could propagate back to the caller.
 *
 * Reuses the existing collector (captureDriverObservation) unconditionally
 * — no location-freshness gate is applied here, unlike
 * lib/driverContext/baselineObservationSync.ts's processDriver. That's
 * intentional, not an oversight: a baseline observation implicitly claims
 * "the vehicle was live at this moment," which a stale/unavailable location
 * can't support, so baseline skips. An event-triggered observation's whole
 * purpose is provenance around a specific event — even a stale/unavailable
 * current location is still useful context (alongside HOS state, weather
 * availability, and the event's OWN lat/lng already on DriverEvent itself),
 * so it is always persisted as long as the collector can produce a record
 * at all.
 */

import { prisma } from "@/lib/prisma";
import { captureDriverObservation, type CaptureDriverObservationDeps } from "./captureObservation";

export interface NewDriverEventRef {
  id: string;
  driverId: string;
}

export interface EnrichmentStats {
  eventsCreated: number;
  enrichmentAttempted: number;
  enrichmentCreated: number;
  enrichmentSkipped: number;
  enrichmentFailed: number;
}

/** Same P2002-detection pattern used in lib/providers/samsara/syncLock.ts and syncSafetyEvents.ts — kept as a local copy rather than a shared util, matching this codebase's existing precedent of small, independent copies over a premature shared abstraction. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

function emptyEnrichmentStats(eventsCreated: number): EnrichmentStats {
  return {
    eventsCreated,
    enrichmentAttempted: 0,
    enrichmentCreated: 0,
    enrichmentSkipped: 0,
    enrichmentFailed: 0,
  };
}

/** Minimal slice of the Prisma DriverObservation delegate this module needs for the already_enriched idempotency check. */
export interface EnrichmentObservationClient {
  findFirst(args: {
    where: { driverEventId: string; triggerType: "safety_event" };
    select: { id: true };
  }): Promise<{ id: string } | null>;
}

export interface EnrichNewDriverEventsDeps {
  /** Injectable for tests; defaults to prisma.driverObservation. */
  observationClient?: EnrichmentObservationClient;
  /** Injectable for tests; defaults to the real captureDriverObservation. */
  captureDriverObservationFn?: typeof captureDriverObservation;
  /** Passed through to captureDriverObservationFn — lets tests fake the underlying provider calls without touching this module's own idempotency/failure-isolation logic. */
  captureDeps?: CaptureDriverObservationDeps;
}

/**
 * Attempts one safety_event-triggered DriverObservation per newly created
 * DriverEvent.
 *
 * Idempotent per event (Requirement A, Phase 6B.4): if a DriverObservation
 * already exists with this driverEventId AND triggerType "safety_event", it
 * is skipped as already_enriched rather than duplicated — this makes the
 * whole function (and by extension a retried sync run) safe to call again
 * for the same events. Deliberately does NOT deduplicate ACROSS different
 * DriverEvents close together in time (Requirement B) — two genuinely
 * distinct new events each get their own attempt and their own observation,
 * even a minute apart. Clearer provenance now; safe to revisit with a real
 * cooldown window later if real data shows bursts are a provider-call
 * volume problem.
 */
export async function enrichNewDriverEvents(
  events: NewDriverEventRef[],
  deps: EnrichNewDriverEventsDeps = {}
): Promise<EnrichmentStats> {
  const observationClient = deps.observationClient ?? prisma.driverObservation;
  const captureFn = deps.captureDriverObservationFn ?? captureDriverObservation;

  const stats = emptyEnrichmentStats(events.length);

  for (const event of events) {
    stats.enrichmentAttempted++;
    try {
      const existing = await observationClient.findFirst({
        where: { driverEventId: event.id, triggerType: "safety_event" },
        select: { id: true },
      });
      if (existing) {
        stats.enrichmentSkipped++;
        continue;
      }

      await captureFn(
        { driverId: event.driverId, triggerType: "safety_event", driverEventId: event.id },
        deps.captureDeps
      );
      stats.enrichmentCreated++;
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // The findFirst pre-check above is an optimization, not the source
        // of truth — DriverObservation's DB-level
        // @@unique([driverEventId, triggerType]) constraint (Phase 6B.5) is.
        // A concurrent enrichment attempt won the race and created this
        // event's observation between our pre-check and our own create()
        // call. Same P2002-as-"someone else already did this" pattern
        // already used elsewhere in this codebase (RawProviderEvent
        // dedup in syncSafetyEvents.ts, the sync lock in syncLock.ts) —
        // this is exactly already_enriched, not a real failure.
        console.info(
          `[event-enrichment] driverEventId="${event.id}" was already enriched by a concurrent attempt (unique constraint) — treating as already_enriched.`
        );
        stats.enrichmentSkipped++;
        continue;
      }

      // Any other error (a real DB failure, a provider failure the
      // collector itself couldn't recover from, etc.) is a genuine
      // enrichment failure — never hidden under the already_enriched path.
      console.error(
        `[event-enrichment] Failed to capture observation for driverEventId="${event.id}":`,
        err instanceof Error ? err.message : err
      );
      stats.enrichmentFailed++;
    }
  }

  return stats;
}

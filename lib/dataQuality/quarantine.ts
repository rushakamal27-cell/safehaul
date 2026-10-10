/**
 * lib/dataQuality/quarantine.ts
 *
 * Declarative quarantine list for historical pilot data that is known to be
 * untrustworthy, plus one predicate for asking "may I use this row?".
 *
 * Why a config module and not a schema change (Phase 6D closure, 2026-10-07):
 * the contaminated rows are not distinguishable from clean ones by anything
 * stored on them — the telemetry was fully live, it just belonged to the wrong
 * vehicle. Marking them in the database would mean either adding a column/
 * table or mutating historical rows; Phase 6D forbids both. A small, explicit,
 * version-controlled list is auditable (it shows up in code review and git
 * history), needs no migration, and is trivially testable.
 *
 * This module is deliberately NOT wired into existing production readers. Its
 * only intended consumer today is a future Phase 7 analytics/dataset loader,
 * which must consult it before admitting a row into any training or reporting
 * set. The Audit timeline continues to show what was actually recorded.
 *
 * Nothing here deletes, rewrites, or recomputes anything.
 *
 * ---------------------------------------------------------------------------
 * REQUIREMENT FOR PHASE 7 DATASET LOADERS (recorded 2026-10-09)
 *
 * Phase 6D closes with this module still unwired, by explicit product
 * decision. Integrating it into /api/audit is DEFERRED — the Audit timeline
 * goes on showing quarantined rows as recorded. Any Phase 7 loader MUST
 * therefore do the filtering itself. Specifics established by a read-only
 * production audit on 2026-10-08, so the next implementer does not have to
 * rediscover them:
 *
 *   1. Call isHistoricalDataQuarantined for EVERY row of every type listed in
 *      an entry's `affects` before admitting it. Today that means
 *      DriverObservation, SafetyScoreSample, DailySafetyScore and
 *      DailyDrivingSummary. Measured impact: 34 DailySafetyScore + 34
 *      DailyDrivingSummary rows are quarantined for the one affected driver;
 *      all five other pilots have ZERO quarantined rows.
 *
 *   2. Pass the row's own bucket instant as `at`, never "now" — see
 *      QuarantineQuery.at. For DailySafetyScore/DailyDrivingSummary that is
 *      the UTC-midnight `date`.
 *
 *   3. WHOLE DAYS ARE MIXED, and the midnight-`at` convention in (2) handles
 *      it correctly BY CONSTRUCTION — do not "improve" it into an
 *      instant-level comparison. The entry's end bound
 *      (2026-10-07T17:20:03.621Z) falls mid-day, so that day's single
 *      DailySafetyScore row averages 24 hourly samples of which 18 (buckets
 *      00:00-17:00) are contaminated and 6 (18:00-23:00) are clean, yet it is
 *      stored as one indivisible score of 47.9 at sampleCount 24/24. Passing
 *      midnight quarantines the whole day, which is the right conservative
 *      answer: a partly-poisoned average cannot be salvaged without
 *      recomputing it from the surviving samples. If a loader ever wants that
 *      day back, it must rebuild the average from SafetyScoreSample rows that
 *      individually clear the predicate — never by relaxing this bound.
 *
 *   4. DriverEvent, Trip and ComplianceScore are deliberately absent from
 *      `affects` and must stay usable. Genuine incidents, inspections and
 *      provider events are unaffected by vehicle misattribution.
 *
 *   5. For pre-fix rows, do not trust SafetyScoreSample's stored
 *      `contextStatus` column — recompute from breakdownJson.contextSources
 *      via lib/dataQuality/historicalSamples.ts. That is a separate defect
 *      from this one and both apply to overlapping rows.
 */

/**
 * Historical record types this mechanism can quarantine. Named after the
 * Prisma models so an entry reads unambiguously at the call site.
 */
export type QuarantinableDataType =
  | "DriverObservation"
  | "SafetyScoreSample"
  | "DailySafetyScore"
  | "DailyDrivingSummary"
  | "DriverEvent"
  | "Trip"
  | "ComplianceScore";

export interface QuarantineEntry {
  /** Internal SafeHaul Driver.id — never a name, never a provider ID. */
  driverId: string;
  /** Inclusive UTC start instant. */
  fromInclusive: Date;
  /**
   * EXCLUSIVE UTC end instant, or null for "still ongoing / open-ended".
   * Exclusive so a whole-day range is expressed without 23:59:59.999
   * guesswork: "through 2026-10-07" is `2026-10-08T00:00:00.000Z`.
   */
  toExclusive: Date | null;
  /** Stable machine-readable cause; grep-able, never free prose. */
  reason: QuarantineReason;
  /** Record types this entry applies to. Anything not listed stays usable. */
  affects: readonly QuarantinableDataType[];
  /** Human context for reviewers. Not used in any comparison. */
  note: string;
}

export type QuarantineReason = "wrong_vehicle_attribution";

/**
 * Everything derived from a driver's *context* (position, speed, weather, zone
 * and the scores/summaries computed from them). Deliberately excludes
 * DriverEvent: a safety event carries its own payload coordinates and its own
 * driver attribution straight from the provider, so it is unaffected by which
 * vehicle our resolver happened to pick.
 */
const CONTEXT_DERIVED: readonly QuarantinableDataType[] = [
  "DriverObservation",
  "SafetyScoreSample",
  "DailySafetyScore",
  "DailyDrivingSummary",
];

/**
 * THE LIST. Add entries here; never mutate production rows instead.
 *
 * Entry 1 — driver cmnq65l6c0001nytoxvfipwt9 (Rushana), wrong_vehicle_attribution.
 *   Her DriverProviderMapping.externalVehicleId still pointed at her previous
 *   truck (281474991238949 / "TRUCK 226") after she moved to 281475006503539 /
 *   "TRUCK 284". Because vehicle resolution preferred the stored mapping over
 *   her own live events, every GPS/speed/weather/zone reading and every daily
 *   odometer delta recorded for her came from the old truck — which a different
 *   driver was operating, verified live ~2,000 miles away on 2026-10-07.
 *
 *   Confirmed contaminated 2026-09-21 onward: her DriverEvent coordinates and
 *   her DriverObservation coordinates diverge by 99–2,531 miles from that date.
 *   Indeterminate 2026-09-04 → 2026-09-20: her last clean event/observation
 *   agreement is 2026-09-03 (2 mi apart) and her first event on the new truck
 *   is 2026-09-21, so the switch happened somewhere inside that gap. The wider
 *   range is used on purpose — an over-inclusive quarantine costs some usable
 *   days, an under-inclusive one poisons the dataset.
 *
 *   END BOUND IS FINAL, and is data-derived rather than taken from the deploy
 *   timestamp (2026-10-07T17:06:08Z). The fix shipped in that deploy, but the
 *   narrowest defensible bound is the first row positively verified clean, not
 *   the moment the build went live — a cron run already in flight could in
 *   principle still have written with the old code. Verified in production:
 *     - last contaminated observation: 2026-10-07T17:00:03.191Z
 *       (providerVehicleId 281474991238949 / "TRUCK 226",
 *        vehicleIdSource "provider_mapping", 1,533 mi from her own events)
 *     - last contaminated sample:      hourBucket 2026-10-07T17:00:00.000Z
 *       (sampledAt 17:05:02.585Z, 66 s before the merge)
 *     - ZERO rows of any kind written in between
 *     - first clean observation:       2026-10-07T17:20:03.621Z
 *       (providerVehicleId 281475006503539 / "TRUCK 284",
 *        vehicleIdSource "driver_event") — this instant is the bound
 *     - first admitted sample:         hourBucket 2026-10-07T18:00:00.000Z
 *       (partial_live, dataCompleteness 5/6, all-fresh observed context)
 *     - all 32 post-bound observations cite TRUCK 284; none cite TRUCK 226
 *   Because toExclusive is exclusive, the bound admits exactly the first
 *   verified-clean row onward and quarantines everything before it.
 */
export const QUARANTINE_ENTRIES: readonly QuarantineEntry[] = [
  {
    driverId: "cmnq65l6c0001nytoxvfipwt9",
    fromInclusive: new Date("2026-09-04T00:00:00.000Z"),
    // First production row verified clean after the fix deployed — see the
    // comment block above for the full evidence chain.
    toExclusive: new Date("2026-10-07T17:20:03.621Z"),
    reason: "wrong_vehicle_attribution",
    affects: CONTEXT_DERIVED,
    note:
      "Stale DriverProviderMapping.externalVehicleId: context sourced from TRUCK 226 " +
      "(281474991238949) while the driver was operating TRUCK 284 (281475006503539). " +
      "Confirmed from 2026-09-21; 2026-09-04 to 2026-09-20 indeterminate and included " +
      "deliberately. Ends at the first post-fix observation verified to cite TRUCK 284 " +
      "(2026-10-07T17:20:03.621Z). DriverEvent rows are unaffected and remain usable.",
  },
];

export interface QuarantineQuery {
  /** Internal Driver.id of the row's owner. */
  driverId: string;
  /** Which record type the row is. */
  dataType: QuarantinableDataType;
  /**
   * The row's own UTC instant: DriverObservation.observedAt,
   * SafetyScoreSample.hourBucket, or the UTC-midnight `date` of a
   * DailySafetyScore / DailyDrivingSummary. Always pass the row's bucket
   * instant, never "now".
   */
  at: Date;
}

/**
 * True when a row must NOT be treated as clean analytics/training data.
 *
 * Comparison is on absolute UTC instants (Date.getTime), so it is immune to
 * the host process's local timezone. Start is inclusive, end is exclusive, and
 * a null end means open-ended. Pure and deterministic — no DB, no clock, no
 * provider calls, no driver-name matching.
 */
export function isHistoricalDataQuarantined(query: QuarantineQuery): boolean {
  return findQuarantineEntry(query) !== null;
}

/**
 * Same test as isHistoricalDataQuarantined, but returns the matching entry so
 * a caller can log or report WHY a row was excluded. Returns the first match;
 * entries are not expected to overlap for one (driver, dataType).
 */
export function findQuarantineEntry(query: QuarantineQuery): QuarantineEntry | null {
  const at = query.at.getTime();

  for (const entry of QUARANTINE_ENTRIES) {
    if (entry.driverId !== query.driverId) continue;
    if (!entry.affects.includes(query.dataType)) continue;
    if (at < entry.fromInclusive.getTime()) continue;
    if (entry.toExclusive !== null && at >= entry.toExclusive.getTime()) continue;
    return entry;
  }

  return null;
}

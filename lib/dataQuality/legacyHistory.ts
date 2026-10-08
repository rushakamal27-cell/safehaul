/**
 * lib/dataQuality/legacyHistory.ts
 *
 * Read-time classification of LEGACY Trip / ComplianceScore / SafetyEvent
 * rows as synthetic, or not-confidently-classifiable.
 *
 * Why these three tables and no others. Exactly one code path ever wrote
 * them: the daily-history block in app/api/risk/route.ts, introduced in
 * 6acea83 and deleted in 8f46d95 (Remove Implicit Demo Fallback). At HEAD
 * there is no writer for ComplianceScore or SafetyEvent at all, and the only
 * writer for Trip is lib/trip.ts::getOrCreateTodayTrip, called from
 * /api/incident and /api/inspect for real driver-initiated actions. So this
 * module describes a closed, historical population that cannot grow.
 *
 * That block fed on whatever assembleDriverContext returned. For a driver
 * with no active pilot mapping it returned mock scenario data, so the rows it
 * wrote hold a fabricated mileage constant, a fabricated weather/zone
 * snapshot, a score computed from fabricated inputs, and safety events
 * invented from a driverId hash. For a PILOT, before the 9bde2ef cutover,
 * the same block ran on real GPS/weather/zone data and the rows it wrote are
 * genuine history. Nothing in the rows themselves records which happened.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, and why it needs no dates of its own
 *
 * The mock path required `isPilotDriver(driverId) === false`, which requires
 * a DriverProviderMapping that is either absent or not isPilot+isActive. So:
 *
 *   1. no DriverProviderMapping row exists for this driver, ever
 *      -> the driver could never have been a pilot, so every legacy row of
 *         theirs was written from mock context.                 SYNTHETIC
 *
 *   2. the row was created BEFORE that mapping was created
 *      -> at write time the driver had no mapping at all, so the same
 *         argument applies to that row specifically.             SYNTHETIC
 *
 *   3. otherwise
 *      -> a mapping existed when the row was written. Whether isPilot and
 *         isActive were true AT THAT MOMENT is not recorded anywhere, and
 *         the flags have been changed by raw SQL in the past (which bypasses
 *         Prisma's @updatedAt, so even updatedAt cannot bound it). The row
 *         may be genuine pilot history.                          AMBIGUOUS
 *
 * Ambiguous rows are NOT excluded. Hiding a driver's real history to tidy up
 * a display is a worse failure than showing a labelled legacy row, and this
 * project's standing rule is that "unknown" is reported as unknown rather
 * than guessed.
 *
 * Deliberately NOT used: any absolute date threshold. An earlier draft added
 * "written after the 9bde2ef cutover -> synthetic", which is sound in theory
 * (after it, the block only ran for non-pilots) but requires guessing the
 * DEPLOY instant from a COMMIT instant, and a row written in that gap would
 * be wrongly excluded. Measured against production it classified zero
 * additional rows, so it bought nothing and was dropped. Rules 1 and 2 use
 * only per-driver causal facts.
 *
 * ---------------------------------------------------------------------------
 * CREATED-AT, NOT UPDATED-AT
 *
 * Classification must read `createdAt`. `Trip.updatedAt` and
 * `ComplianceScore.updatedAt` are @updatedAt columns and were REWRITTEN in
 * bulk by the sampleCount backfill: 61 of 70 rows in each table now carry the
 * identical instant 2026-08-20T15:10:52.615Z, erasing their true write time.
 * `createdAt` is `@default(now())` with no @updatedAt and is intact.
 *
 * (Those same corrupted values are what the Audit screen currently DISPLAYS
 * as each legacy row's date — a separate display bug, reported but not fixed
 * here, since it misdates genuine rows rather than fabricating synthetic ones.)
 */

/**
 * `synthetic` — positively identified as generated from mock scenario data.
 * `ambiguous` — a mapping existed at write time; genuineness cannot be
 * established from stored data, so the row is shown.
 *
 * There is intentionally no `genuine` member. Nothing in these three tables
 * can be POSITIVELY confirmed genuine from stored data alone; `ambiguous` is
 * the honest upper bound, and inventing a `genuine` label would overstate
 * what the provenance supports.
 */
export type LegacyRowProvenance = "synthetic" | "ambiguous";

export interface LegacyRowClassificationInput {
  /**
   * The row's immutable `createdAt`. Never pass `updatedAt` — see this
   * file's CREATED-AT note.
   */
  rowCreatedAt: Date;
  /**
   * `DriverProviderMapping.createdAt` for this row's driver, or null when the
   * driver has no mapping of any kind. Flag state (isPilot/isActive) is
   * deliberately NOT an input: it describes the mapping NOW, not at the
   * moment the row was written, and using it would misclassify both a
   * deactivated pilot's genuine rows and a newly-onboarded pilot's synthetic
   * pre-onboarding rows.
   */
  providerMappingCreatedAt: Date | null;
}

export function classifyLegacyRiskRow(input: LegacyRowClassificationInput): LegacyRowProvenance {
  // Rule 1 — never mapped to any provider, so never a pilot, so every legacy
  // row of theirs came from mock context.
  if (input.providerMappingCreatedAt === null) return "synthetic";

  // Rule 2 — written before the driver was mapped at all. Strict `<`: a row
  // created in the same instant as the mapping is not provably pre-mapping,
  // so it falls through to ambiguous rather than being excluded. Compared via
  // getTime() to avoid relying on Date's relational-operator coercion, the
  // same convention as lib/dataQuality/quarantine.ts.
  if (input.rowCreatedAt.getTime() < input.providerMappingCreatedAt.getTime()) return "synthetic";

  // Rule 3 — a mapping existed; the flags at that moment are unrecorded.
  return "ambiguous";
}

/** True when the row must be hidden from the Audit trail. */
export function isLegacySyntheticRow(input: LegacyRowClassificationInput): boolean {
  return classifyLegacyRiskRow(input) === "synthetic";
}

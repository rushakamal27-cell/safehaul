/**
 * lib/riskPersistence.ts
 *
 * Single source of truth for whether /api/risk's live Heads-Up calculation
 * is also allowed to write daily historical Audit records (legacy Trip /
 * ComplianceScore snapshots). As of this architecture correction, it is not,
 * for pilot drivers — history is now owned exclusively by the autonomous
 * lib/riskSampling/ pipeline (hourly SafetyScoreSample -> daily
 * DailySafetyScore/DailyDrivingSummary). Demo (non-pilot) drivers are the
 * one exception: they have no autonomous collection pipeline at all, so
 * /api/risk remains their only source of Trip/ComplianceScore history — see
 * app/api/risk/route.ts's file header for the full rationale.
 *
 * Extracted as its own pure predicate (rather than an inline `!pilotDriver`
 * check in the route) so this specific policy — "opening the app must not
 * create daily historical Audit records for a pilot driver" — is directly
 * unit-testable under this project's lib/**\/__tests__ convention, since
 * app/api/risk/route.ts itself is outside the test glob.
 *
 * Phase 6D closure (2026-10-08): the original predicate was `!pilotDriver`,
 * which treated "not an active pilot" as "is a demo account." That is wrong
 * for a DEACTIVATED pilot. A real pilot driver was set to
 * isPilot=false/isActive=false in production; `!pilotDriver` then became true
 * for him, which would have re-enabled this route's demo writes — stamping a
 * MOCK mileage value from lib/mockScenarios.ts onto a Trip row, plus a
 * mock-context ComplianceScore and fabricated SafetyEvent rows, the moment he
 * next opened the Mini App. Deactivating a pilot must stop collection, not
 * silently switch it to synthetic data. The predicate now also requires the
 * driver to have no provider mapping at all before any demo write is allowed.
 */

export interface DailyHistoryPersistenceInput {
  /** True when the driver has an active, pilot-flagged provider mapping. */
  pilotDriver: boolean;
  /**
   * True when the driver has a DriverProviderMapping row of ANY kind,
   * regardless of its isPilot/isActive flags — see
   * lib/driverEvents.ts::hasProviderMapping.
   */
  hasProviderMapping: boolean;
}

/**
 * Three driver categories, two of which must never write synthetic history:
 *
 *   | category                      | pilotDriver | hasProviderMapping | writes |
 *   |-------------------------------|-------------|--------------------|--------|
 *   | genuine demo user             | false       | false              | YES    |
 *   | active pilot driver           | true        | true               | no     |
 *   | deactivated / former pilot    | false       | true               | no     |
 *
 * Takes a named object rather than two positional booleans on purpose: two
 * same-typed positional flags transpose silently and TypeScript cannot catch
 * it, and getting this exact pair backwards is what the bug below looked like.
 */
export function shouldPersistDailyHistory(input: DailyHistoryPersistenceInput): boolean {
  return !input.pilotDriver && !input.hasProviderMapping;
}

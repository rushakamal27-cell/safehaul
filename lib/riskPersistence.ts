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
 */
export function shouldPersistDailyHistory(pilotDriver: boolean): boolean {
  return !pilotDriver;
}

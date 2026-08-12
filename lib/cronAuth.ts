/**
 * lib/cronAuth.ts
 *
 * Shared CRON_SECRET bearer-token check for ops/sync routes. Extracted
 * (Phase 6B.3) so this logic is unit-testable — route handlers under app/
 * are outside this project's test glob (lib/**\/__tests__/**\/*.test.ts, see
 * CLAUDE.md), so auth logic that stays inline in a route file can only ever
 * be exercised manually.
 *
 * app/api/sync/samsara-safety-events/route.ts is deliberately NOT migrated
 * to use this helper as part of this phase — its own local verifyCronSecret
 * has identical behavior but is left untouched per this phase's explicit
 * "do not change the existing Safety Events route" scope.
 */

export function verifyCronSecret(authorizationHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron-auth] CRON_SECRET env var is not set");
    return false;
  }
  return authorizationHeader === `Bearer ${secret}`;
}

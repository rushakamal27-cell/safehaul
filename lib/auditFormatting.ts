/**
 * lib/auditFormatting.ts
 *
 * Shared display formatting for app/api/audit/route.ts. Extracted so it's
 * unit-testable under the lib/**\/__tests__ pattern (route handlers aren't
 * covered by the test runner's glob) — no behavior change from extraction
 * itself.
 */

// Explicitly formats in UTC and labels it as such. SafeHaul has no
// trustworthy per-driver timezone yet — formatting with no `timeZone` option
// previously happened to read as UTC only because Vercel's Node.js runtime
// defaults to UTC, with no indication to the user that the printed time
// wasn't their local time. Never display a UTC instant as if it were
// unlabeled local time.
export function formatAuditDate(date: Date): string {
  return `📅 ${date
    .toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    })
    .toUpperCase()} UTC`;
}

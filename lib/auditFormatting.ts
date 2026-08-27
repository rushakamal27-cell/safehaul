/**
 * lib/auditFormatting.ts
 *
 * Shared display formatting for app/api/audit/route.ts. Extracted so it's
 * unit-testable under the lib/**\/__tests__ pattern (route handlers aren't
 * covered by the test runner's glob) — no behavior change from extraction
 * itself.
 *
 * Localization (2026-08-27): `formatAuditDate` takes an optional `language`
 * (default `"en"`), switching only the `Intl`/`toLocaleString` locale
 * (`"en-US"` vs `"ru-RU"`) used to render month names — the UTC timezone,
 * "always show UTC, never unlabeled local time" rule, and overall shape are
 * unchanged. This is purely a frontend/lib formatting choice — no backend
 * timestamp semantics change; existing callers/tests (no `language` arg)
 * keep their exact prior "en-US" output.
 */

import type { Language } from "./i18n/translations";

// Explicitly formats in UTC and labels it as such. SafeHaul has no
// trustworthy per-driver timezone yet — formatting with no `timeZone` option
// previously happened to read as UTC only because Vercel's Node.js runtime
// defaults to UTC, with no indication to the user that the printed time
// wasn't their local time. Never display a UTC instant as if it were
// unlabeled local time.
export function formatAuditDate(date: Date, language: Language = "en"): string {
  const locale = language === "ru" ? "ru-RU" : "en-US";
  return `📅 ${date
    .toLocaleString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    })
    .toUpperCase()} UTC`;
}

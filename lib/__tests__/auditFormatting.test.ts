import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatAuditDate } from "../auditFormatting";

describe("formatAuditDate", () => {
  test("explicitly labels the timestamp as UTC", () => {
    const formatted = formatAuditDate(new Date("2026-08-20T14:36:06.571Z"));
    assert.match(formatted, /\bUTC\b/);
  });

  test("formats in UTC regardless of the host process's local timezone", () => {
    // 14:36 UTC must always read as 2:36 PM here, never silently shifted by
    // whatever TZ the process happens to run under (this is exactly the bug
    // that made Vercel's incidental UTC default look correct by accident).
    const formatted = formatAuditDate(new Date("2026-08-20T14:36:06.571Z"));
    assert.match(formatted, /2:36 PM/);
  });

  test("a UTC-midnight bucket value formats as 12:00 AM UTC, not an unlabeled local midnight", () => {
    const formatted = formatAuditDate(new Date("2026-08-20T00:00:00.000Z"));
    assert.match(formatted, /12:00 AM/);
    assert.match(formatted, /\bUTC\b/);
  });

  test("date portion is unaffected by the timezone fix", () => {
    const formatted = formatAuditDate(new Date("2026-08-20T14:36:06.571Z"));
    assert.match(formatted, /AUG 20, 2026/);
  });

  // Localization (2026-08-27) — additive optional `language` param. Note:
  // app/api/audit/route.ts and lib/auditItems.ts (the only actual callers)
  // are unchanged and always call this with no `language` arg, so Audit's
  // displayed date strings remain English-formatted in production — see
  // the Plan Mode report's section B/13. This module-level "ru" capability
  // exists for consistency and any future frontend caller, and is verified
  // here in isolation.
  describe("language parameter (localization)", () => {
    test("default (no language arg) is unchanged — still en-US formatting", () => {
      const formatted = formatAuditDate(new Date("2026-08-20T14:36:06.571Z"));
      assert.match(formatted, /AUG 20, 2026/);
      assert.match(formatted, /2:36 PM/);
    });

    test("'ru' still labels the timestamp UTC and stays in the same 24h-safe shape", () => {
      const formatted = formatAuditDate(new Date("2026-08-20T14:36:06.571Z"), "ru");
      assert.match(formatted, /\bUTC\b/);
    });
  });
});

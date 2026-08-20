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
});

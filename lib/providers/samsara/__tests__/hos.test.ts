import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseHosClockEntry, type SamsaraHosClockEntry } from "../hos";

const NOW = new Date("2026-07-14T12:00:00.000Z");

describe("parseHosClockEntry", () => {
  test("undefined entry -> unavailable", () => {
    const parsed = parseHosClockEntry(undefined, NOW);
    assert.deepEqual(parsed, {
      drivingHoursRemaining: null,
      shiftHoursUsed: null,
      status: "unavailable",
      updatedAt: null,
    });
  });

  test("entry with no shift elapsed data -> unavailable", () => {
    const entry: SamsaraHosClockEntry = { driver: { id: "d1" }, clocks: {} };
    const parsed = parseHosClockEntry(entry, NOW);
    assert.equal(parsed.status, "unavailable");
    assert.equal(parsed.shiftHoursUsed, null);
  });

  test("well-formed recent entry -> available, converts ms to hours", () => {
    const entry: SamsaraHosClockEntry = {
      driver: { id: "d1" },
      clocks: {
        drive: { durationMsRemaining: 3_600_000 * 4 },
        shift: { durationMsElapsed: 3_600_000 * 6.5 },
      },
      lastUpdatedAtTime: new Date(NOW.getTime() - 60_000).toISOString(), // 1 min ago
    };
    const parsed = parseHosClockEntry(entry, NOW);
    assert.equal(parsed.status, "available");
    assert.equal(parsed.drivingHoursRemaining, 4);
    assert.equal(parsed.shiftHoursUsed, 6.5);
  });

  test("entry older than the staleness threshold -> stale, not available", () => {
    const entry: SamsaraHosClockEntry = {
      driver: { id: "d1" },
      clocks: { shift: { durationMsElapsed: 3_600_000 * 3 } },
      lastUpdatedAtTime: new Date(NOW.getTime() - 45 * 60_000).toISOString(), // 45 min ago
    };
    const parsed = parseHosClockEntry(entry, NOW);
    assert.equal(parsed.status, "stale");
    assert.equal(parsed.shiftHoursUsed, 3);
  });

  test("malformed clocks field (wrong type) is ignored, not thrown", () => {
    const entry = { driver: { id: "d1" }, clocks: { shift: { durationMsElapsed: "not-a-number" } } } as unknown as SamsaraHosClockEntry;
    const parsed = parseHosClockEntry(entry, NOW);
    assert.equal(parsed.status, "unavailable");
    assert.equal(parsed.shiftHoursUsed, null);
  });
});

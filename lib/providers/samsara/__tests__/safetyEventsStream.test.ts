import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSafetyEventsStreamUrl } from "../safetyEventsStream";

// Regression coverage for the 2026-07-18 pagination bug: `startTime` was
// being dropped whenever `afterCursor` was present, which made every
// continuation request fail with a 400 "startTime is missing from query
// string" — misdiagnosed downstream as an expired cursor. See
// syncSafetyEvents.ts's file header for the full incident writeup.

describe("buildSafetyEventsStreamUrl", () => {
  test("first-page (cold-start) request: includes startTime, does not include after", () => {
    const url = new URL(
      buildSafetyEventsStreamUrl({
        startTime: "2026-07-17T00:00:00.000Z",
        driverIds: ["111", "222"],
      })
    );

    assert.equal(url.searchParams.get("startTime"), "2026-07-17T00:00:00.000Z");
    assert.equal(url.searchParams.has("after"), false);
    assert.equal(url.searchParams.get("driverIds"), "111,222");
    assert.equal(url.searchParams.get("queryByTimeField"), "createdAtTime");
  });

  test("continuation request: includes the original startTime AND after together", () => {
    const url = new URL(
      buildSafetyEventsStreamUrl({
        startTime: "2026-07-17T00:00:00.000Z",
        afterCursor: "cursor-abc123",
        driverIds: ["111", "222"],
      })
    );

    assert.equal(
      url.searchParams.get("startTime"),
      "2026-07-17T00:00:00.000Z",
      "startTime must still be present on a continuation request"
    );
    assert.equal(url.searchParams.get("after"), "cursor-abc123");
    assert.equal(url.searchParams.get("driverIds"), "111,222");
    assert.equal(url.searchParams.get("queryByTimeField"), "createdAtTime");
  });

  test("driverIds is omitted entirely when empty", () => {
    const url = new URL(
      buildSafetyEventsStreamUrl({ startTime: "2026-07-17T00:00:00.000Z", driverIds: [] })
    );
    assert.equal(url.searchParams.has("driverIds"), false);
  });
});

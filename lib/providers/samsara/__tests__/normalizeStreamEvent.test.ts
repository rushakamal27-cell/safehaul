import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeSafetyStreamEvent } from "../normalizeStreamEvent";
import type { SamsaraSafetyStreamEvent } from "../types";

// Regression coverage for the 2026-08-xx "Crash" mapping gap: a real Samsara
// v2 Safety Events Stream event for pilot driver Rushana (2026-08-07,
// externalEventId "5445dc28-0e86-5987-8953-e0d4791b8cde") had
// behaviorLabels: [{ label: "Crash", source: "SYSTEM" }] — SAMSARA_TYPE_MAP
// had no entry for it, so this exact fixture (trimmed to the fields
// normalizeSafetyStreamEvent actually reads) previously returned
// skipReason "unsupported_behavior_label" instead of a normalized event.
// The RawProviderEvent was correctly preserved either way; only DriverEvent
// creation was affected — see the backfill script for recovering that one
// specific historical event.
function realCrashFixture(): SamsaraSafetyStreamEvent {
  return {
    id: "5445dc28-0e86-5987-8953-e0d4791b8cde",
    asset: { id: "281474991238949" },
    driver: { id: "51056167" },
    startMs: "2026-08-07T12:17:20.518Z",
    endMs: "2026-08-07T12:17:20.518Z",
    location: { latitude: 40.303951, longitude: -74.496325 },
    behaviorLabels: [{ label: "Crash", source: "SYSTEM" }],
    // No `severity` field — confirmed absent on the real stored payload,
    // same as every other event type observed for this fleet.
  };
}

describe("normalizeSafetyStreamEvent — Crash", () => {
  test("the real Aug 7 Crash event now normalizes successfully to type 'crash'", () => {
    const result = normalizeSafetyStreamEvent(realCrashFixture());

    assert.equal(result.skipReason, undefined);
    assert.ok(result.event, "must produce a normalized event, not a skip");
    assert.equal(result.event!.type, "crash");
    assert.equal(result.event!.externalDriverId, "51056167");
    assert.equal(result.event!.externalVehicleId, "281474991238949");
    assert.equal(result.event!.externalEventId, "5445dc28-0e86-5987-8953-e0d4791b8cde");
    assert.equal(result.event!.timestamp, "2026-08-07T12:17:20.518Z");
    assert.equal(result.event!.lat, 40.303951);
    assert.equal(result.event!.lng, -74.496325);
    // No severity field on the real payload -> normalizeSeverity's
    // documented fallback, same as every other unscored-severity event type.
    assert.equal(result.event!.severity, 3);
  });

  test("lowercase 'crash' variant also normalizes (defensive casing, matching every other label's convention)", () => {
    const result = normalizeSafetyStreamEvent({
      ...realCrashFixture(),
      behaviorLabels: [{ label: "crash", source: "SYSTEM" }],
    });
    assert.equal(result.event?.type, "crash");
  });

  test("a Crash label alongside another recognized label still resolves — first supported match wins, unchanged multi-label behavior", () => {
    const result = normalizeSafetyStreamEvent({
      ...realCrashFixture(),
      behaviorLabels: [
        { label: "Crash", source: "SYSTEM" },
        { label: "SevereSpeeding", source: "SYSTEM" },
      ],
    });
    assert.equal(result.event?.type, "crash");
  });

  test("an explicit severity string (if Samsara ever sends one for a crash) is still respected, not overridden", () => {
    const result = normalizeSafetyStreamEvent({ ...realCrashFixture(), severity: "critical" });
    assert.equal(result.event?.severity, 5);
  });
});

describe("normalizeSafetyStreamEvent — existing mappings unchanged (regression guard)", () => {
  test("SevereSpeeding -> speeding, still works exactly as before", () => {
    const result = normalizeSafetyStreamEvent({
      id: "evt-1",
      driver: { id: "111" },
      startMs: "2026-08-01T00:00:00.000Z",
      behaviorLabels: [{ label: "SevereSpeeding", source: "SYSTEM" }],
    });
    assert.equal(result.event?.type, "speeding");
  });

  test("FollowingDistance -> following_distance, still works exactly as before", () => {
    const result = normalizeSafetyStreamEvent({
      id: "evt-2",
      driver: { id: "111" },
      startMs: "2026-08-01T00:00:00.000Z",
      behaviorLabels: [{ label: "FollowingDistance", source: "SYSTEM" }],
    });
    assert.equal(result.event?.type, "following_distance");
  });

  test("RollingStop -> rolling_stop, still works exactly as before", () => {
    const result = normalizeSafetyStreamEvent({
      id: "evt-3",
      driver: { id: "111" },
      startMs: "2026-08-01T00:00:00.000Z",
      behaviorLabels: [{ label: "RollingStop", source: "SYSTEM" }],
    });
    assert.equal(result.event?.type, "rolling_stop");
  });

  test("a genuinely unsupported label is still skipped, not accidentally caught by the Crash addition", () => {
    const result = normalizeSafetyStreamEvent({
      id: "evt-4",
      driver: { id: "111" },
      startMs: "2026-08-01T00:00:00.000Z",
      behaviorLabels: [{ label: "SomeFutureUnmappedLabel", source: "SYSTEM" }],
    });
    assert.equal(result.event, null);
    assert.equal(result.skipReason, "unsupported_behavior_label");
    assert.deepEqual(result.observedLabels, ["SomeFutureUnmappedLabel"]);
  });
});

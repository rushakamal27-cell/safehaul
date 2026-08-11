import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SAMSARA_TYPE_MAP, normalizeSamsaraEvent } from "../normalizeEvent";
import type { SamsaraWebhookEnvelope } from "../types";

// Regression coverage for the 2026-08-xx "Crash" mapping addition — see
// normalizeStreamEvent.test.ts for the v2 Stream path (what actually
// carried the real Aug 7 event in production); this file covers
// SAMSARA_TYPE_MAP directly and the webhook (v1) normalizer, which shares
// the same map.

describe("SAMSARA_TYPE_MAP — crash", () => {
  test("both casing variants map to the same internal type", () => {
    assert.equal(SAMSARA_TYPE_MAP["Crash"], "crash");
    assert.equal(SAMSARA_TYPE_MAP["crash"], "crash");
  });
});

describe("SAMSARA_TYPE_MAP — existing entries unchanged (regression guard)", () => {
  test("a representative sample of pre-existing mappings is untouched", () => {
    assert.equal(SAMSARA_TYPE_MAP["HarshBrake"], "harsh_braking");
    assert.equal(SAMSARA_TYPE_MAP["Braking"], "harsh_braking");
    assert.equal(SAMSARA_TYPE_MAP["SevereSpeeding"], "speeding");
    assert.equal(SAMSARA_TYPE_MAP["MaxSpeed"], "speeding");
    assert.equal(SAMSARA_TYPE_MAP["RollingStop"], "rolling_stop");
    assert.equal(SAMSARA_TYPE_MAP["FollowingDistance"], "following_distance");
    assert.equal(SAMSARA_TYPE_MAP["ForwardCollisionWarning"], "forward_collision_warning");
    assert.equal(SAMSARA_TYPE_MAP["MobileUsage"], "mobile_usage");
  });
});

describe("normalizeSamsaraEvent — webhook path, crash", () => {
  function crashEnvelope(): SamsaraWebhookEnvelope {
    return {
      eventType: "Crash",
      data: {
        driver: { id: "51056167" },
        vehicle: { id: "281474991238949" },
        time: "2026-08-07T12:17:20.518Z",
      },
    };
  }

  test("a webhook envelope with eventType 'Crash' normalizes successfully", () => {
    const [normalized] = normalizeSamsaraEvent(crashEnvelope());
    assert.ok(normalized, "must produce a normalized event");
    assert.equal(normalized.type, "crash");
    assert.equal(normalized.externalDriverId, "51056167");
    assert.equal(normalized.externalVehicleId, "281474991238949");
  });

  test("normalizeSamsaraEvent still returns [] for a genuinely unsupported eventType", () => {
    const result = normalizeSamsaraEvent({ eventType: "SomeFutureUnmappedType", data: { driver: { id: "111" } } });
    assert.deepEqual(result, []);
  });

  test("existing webhook mappings still normalize unchanged (regression guard)", () => {
    const [normalized] = normalizeSamsaraEvent({
      eventType: "HarshBrake",
      data: { driver: { id: "111" }, time: "2026-08-01T00:00:00.000Z" },
    });
    assert.equal(normalized.type, "harsh_braking");
  });
});

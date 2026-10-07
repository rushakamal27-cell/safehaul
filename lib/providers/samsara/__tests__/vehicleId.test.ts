import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCurrentVehicleId,
  looksLikeSamsaraId,
  type VehicleMappingClient,
  type VehicleDriverEventClient,
} from "../vehicleId";

// Shared vehicle-ID resolution, extracted from lib/todaySummary.ts so
// mileage and GPS location use the identical trust path. These tests cover
// mapping-sourced, DriverEvent-sourced, whitespace-contaminated, and
// stale-mapping-override branches plus the "neither source" case.

const NOW = new Date("2026-10-07T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

function mappingClient(externalVehicleId: string | null): VehicleMappingClient {
  return { findFirst: async () => (externalVehicleId === null ? { externalVehicleId: null } : { externalVehicleId }) };
}

/** Defaults to an event 1 hour old (fresh) unless an explicit timestamp is given. */
function driverEventClient(externalVehicleId: string | null, timestamp: Date = hoursAgo(1)): VehicleDriverEventClient {
  return { findFirst: async () => (externalVehicleId === null ? null : { externalVehicleId, timestamp }) };
}

describe("looksLikeSamsaraId", () => {
  test("all-digit string is accepted", () => {
    assert.equal(looksLikeSamsaraId("1000000000001"), true);
  });

  test("human-readable truck name is rejected", () => {
    assert.equal(looksLikeSamsaraId("TRUCK 226 (IDEAL)"), false);
  });

  test("empty string is rejected", () => {
    assert.equal(looksLikeSamsaraId(""), false);
  });
});

describe("resolveCurrentVehicleId", () => {
  test("valid numeric mapping ID is accepted and sourced as provider_mapping", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("1000000000001"),
      driverEventClient: driverEventClient(null),
    });
    assert.deepEqual(result, { vehicleId: "1000000000001", source: "provider_mapping" });
  });

  // Real production case (Luka, DriverProviderMapping id="005"): a stored
  // externalVehicleId contaminated with a leading "\r\n" — provider
  // mappings are provisioned out-of-band, so this kind of artifact (a
  // classic Windows/CSV line-ending leftover) can reach the DB undetected.
  test("CR/LF-contaminated mapping ID is trimmed, validated, and sourced as provider_mapping (not the fallback)", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("\r\n281474980432129"),
      // Stale event (30 days) so mapping precedence applies — this test is
      // about trimming, not about the fresh-event override below.
      driverEventClient: driverEventClient("999999999999999", hoursAgo(24 * 30)),
      now: NOW,
    });
    assert.deepEqual(result, { vehicleId: "281474980432129", source: "provider_mapping" });
  });

  test("tab-padded mapping ID is trimmed and accepted", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("\t281474980432129\t"),
      driverEventClient: driverEventClient(null),
    });
    assert.deepEqual(result, { vehicleId: "281474980432129", source: "provider_mapping" });
  });

  test("ordinary leading/trailing space-padded mapping ID is trimmed and accepted", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("  281474980432129  "),
      driverEventClient: driverEventClient(null),
    });
    assert.deepEqual(result, { vehicleId: "281474980432129", source: "provider_mapping" });
  });

  test("clean IDs are returned completely unchanged (no accidental mutation)", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("281474980432129"),
      driverEventClient: driverEventClient(null),
    });
    assert.deepEqual(result, { vehicleId: "281474980432129", source: "provider_mapping" });
    assert.equal(typeof result.vehicleId, "string");
  });

  test("a large Samsara ID survives round-trip as an exact string — no precision loss from numeric conversion", async () => {
    // 281474980432129 exceeds Number.MAX_SAFE_INTEGER-adjacent precision risk
    // territory for some numeric round-trips; assert byte-for-byte string equality.
    const id = "281474980432129";
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient(`\r\n${id}`),
      driverEventClient: driverEventClient(null),
    });
    assert.equal(result.vehicleId, id);
    assert.equal(result.vehicleId?.length, id.length);
  });

  // Phase 6D (2026-10-07): the real production failure — a pilot changed
  // trucks, the manually-provisioned mapping was never updated, and
  // mapping-first precedence meant every GPS/speed/weather/zone reading and
  // daily odometer delta came from the OLD truck (being driven by someone
  // else ~2,000 miles away) for 16 days, while her own DriverEvents had
  // reported the new vehicle the whole time.
  test("STALE MAPPING OVERRIDE: a fresh DriverEvent on a different vehicle beats the mapping", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("281474991238949"), // stale: TRUCK 226
      driverEventClient: driverEventClient("281475006503539", hoursAgo(1)), // real: TRUCK 284
      now: NOW,
    });
    assert.deepEqual(result, { vehicleId: "281475006503539", source: "driver_event" });
  });

  test("agreeing sources are unchanged: fresh event matching the mapping still reports provider_mapping", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("281474990177389"),
      driverEventClient: driverEventClient("281474990177389", hoursAgo(2)),
      now: NOW,
    });
    assert.deepEqual(result, { vehicleId: "281474990177389", source: "provider_mapping" });
  });

  test("a STALE disagreeing event does NOT override the mapping (bounded override)", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("281474991238949"),
      driverEventClient: driverEventClient("281475006503539", hoursAgo(24 * 8)), // 8 days > 7-day window
      now: NOW,
    });
    assert.deepEqual(result, { vehicleId: "281474991238949", source: "provider_mapping" });
  });

  test("an event exactly at the freshness boundary still overrides (inclusive)", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("281474991238949"),
      driverEventClient: driverEventClient("281475006503539", hoursAgo(24 * 7)),
      now: NOW,
    });
    assert.deepEqual(result, { vehicleId: "281475006503539", source: "driver_event" });
  });

  test("override also trims a contaminated event-reported vehicle ID", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("281474991238949"),
      driverEventClient: driverEventClient("\r\n281475006503539", hoursAgo(1)),
      now: NOW,
    });
    assert.deepEqual(result, { vehicleId: "281475006503539", source: "driver_event" });
  });

  test("drivers with no events at all are unaffected by the override (mapping still wins)", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("281474982401184"),
      driverEventClient: driverEventClient(null),
      now: NOW,
    });
    assert.deepEqual(result, { vehicleId: "281474982401184", source: "provider_mapping" });
  });

  test("internal whitespace (not just leading/trailing) is still correctly rejected, not papered over", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("281 474980432129"),
      driverEventClient: driverEventClient("111111111111111"),
    });
    // internal corruption must NOT validate — falls through to the fallback, same as any other invalid mapping value
    assert.deepEqual(result, { vehicleId: "111111111111111", source: "driver_event" });
  });

  test("display-name mapping value is rejected, falls through to DriverEvent", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("TRUCK 226 (IDEAL)"),
      driverEventClient: driverEventClient("1000000000001"),
    });
    assert.deepEqual(result, { vehicleId: "1000000000001", source: "driver_event" });
  });

  test("no mapping row at all falls through to DriverEvent", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient(null),
      driverEventClient: driverEventClient("1000000000002"),
    });
    assert.deepEqual(result, { vehicleId: "1000000000002", source: "driver_event" });
  });

  test("no valid source anywhere returns unavailable", async () => {
    const result = await resolveCurrentVehicleId("drv_1", {
      mappingClient: mappingClient("TRUCK 226 (IDEAL)"),
      driverEventClient: driverEventClient(null),
    });
    assert.deepEqual(result, { vehicleId: null, source: "unavailable" });
  });
});

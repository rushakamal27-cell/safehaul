import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCurrentVehicleId,
  looksLikeSamsaraId,
  type VehicleMappingClient,
  type VehicleDriverEventClient,
} from "../vehicleId";

// Shared vehicle-ID resolution, extracted from lib/todaySummary.ts so
// mileage and GPS location use the identical trust path. Both real pilots
// currently have a non-numeric DriverProviderMapping.externalVehicleId
// (a human-readable truck name) and only resolve via the DriverEvent
// fallback — these tests cover both branches plus the "neither" case.

function mappingClient(externalVehicleId: string | null): VehicleMappingClient {
  return { findFirst: async () => (externalVehicleId === null ? { externalVehicleId: null } : { externalVehicleId }) };
}

function driverEventClient(externalVehicleId: string | null): VehicleDriverEventClient {
  return { findFirst: async () => (externalVehicleId === null ? null : { externalVehicleId }) };
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
      driverEventClient: driverEventClient("999999999999999"), // present but must NOT be used
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

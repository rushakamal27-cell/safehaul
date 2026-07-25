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

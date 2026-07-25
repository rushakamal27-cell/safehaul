import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  odometerDeltaMiles,
  METERS_PER_MILE,
  normalizeVehicleGpsSnapshot,
  type SamsaraVehicleStatsSnapshotResponse,
} from "../vehicleStats";

describe("odometerDeltaMiles", () => {
  test("computes delta between first and last reading, converts meters to miles", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T00:00:10Z", value: 95189915 },
      { time: "2026-07-15T02:52:24Z", value: 95189915 + METERS_PER_MILE * 178 },
    ]);
    assert.equal(Math.round(miles!), 178);
  });

  test("sorts out-of-order readings before computing delta", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T05:00:00Z", value: 1000 + METERS_PER_MILE * 10 },
      { time: "2026-07-15T00:00:00Z", value: 1000 },
    ]);
    assert.equal(Math.round(miles!), 10);
  });

  test("fewer than 2 valid readings -> null (can't compute a delta)", () => {
    assert.equal(odometerDeltaMiles([]), null);
    assert.equal(odometerDeltaMiles([{ time: "2026-07-15T00:00:00Z", value: 1000 }]), null);
  });

  test("readings missing time or value are ignored, not thrown", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T00:00:00Z", value: 1000 },
      { time: undefined, value: 999999 } as { time?: string; value?: number },
      { time: "2026-07-15T01:00:00Z", value: 1000 + METERS_PER_MILE * 5 },
    ]);
    assert.equal(Math.round(miles!), 5);
  });

  test("negative delta (odometer rollback / data anomaly) -> null, not a fabricated 0", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T00:00:00Z", value: 5000 },
      { time: "2026-07-15T01:00:00Z", value: 4000 },
    ]);
    assert.equal(miles, null);
  });

  test("zero delta (vehicle idle all day) -> 0, a real answer, not unavailable", () => {
    const miles = odometerDeltaMiles([
      { time: "2026-07-15T00:00:00Z", value: 5000 },
      { time: "2026-07-15T12:00:00Z", value: 5000 },
    ]);
    assert.equal(miles, 0);
  });
});

// normalizeVehicleGpsSnapshot — verified live against both real pilot
// vehicles on 2026-07-22 (GET /fleet/vehicles/stats?vehicleIds=...&types=gps).
describe("normalizeVehicleGpsSnapshot", () => {
  const VEHICLE_ID = "1000000000001";

  function response(entry: Partial<SamsaraVehicleStatsSnapshotResponse["data"][number]> = {}): SamsaraVehicleStatsSnapshotResponse {
    return {
      data: [
        {
          id: VEHICLE_ID,
          name: "TRUCK 226 (IDEAL)",
          externalIds: { "samsara.serial": "G3ADSRPGZH" },
          gps: {
            time: "2026-07-22T01:33:34Z",
            latitude: 35.078091,
            longitude: -81.721605,
            headingDegrees: 253,
            speedMilesPerHour: 71.447,
            reverseGeo: { formattedLocation: "I 85, Gaffney, SC, 29341" },
            isEcuSpeed: true,
          },
          ...entry,
        },
      ],
      pagination: { endCursor: "", hasNextPage: false },
    };
  }

  test("valid provider response normalizes all fields", () => {
    const reading = normalizeVehicleGpsSnapshot(response(), VEHICLE_ID);
    assert.deepEqual(reading, {
      providerVehicleId: VEHICLE_ID,
      vehicleName: "TRUCK 226 (IDEAL)",
      latitude: 35.078091,
      longitude: -81.721605,
      observedAt: "2026-07-22T01:33:34Z",
      headingDegrees: 253,
      speedMilesPerHour: 71.447,
      isEcuSpeed: true,
      formattedLocation: "I 85, Gaffney, SC, 29341",
    });
  });

  test("missing gps object -> null", () => {
    const reading = normalizeVehicleGpsSnapshot(response({ gps: undefined }), VEHICLE_ID);
    assert.equal(reading, null);
  });

  test("latitude out of range -> null", () => {
    const reading = normalizeVehicleGpsSnapshot(
      response({ gps: { time: "2026-07-22T01:33:34Z", latitude: 95, longitude: -81.7 } }),
      VEHICLE_ID
    );
    assert.equal(reading, null);
  });

  test("longitude out of range -> null", () => {
    const reading = normalizeVehicleGpsSnapshot(
      response({ gps: { time: "2026-07-22T01:33:34Z", latitude: 35, longitude: -200 } }),
      VEHICLE_ID
    );
    assert.equal(reading, null);
  });

  test("invalid/unparseable timestamp -> null", () => {
    const reading = normalizeVehicleGpsSnapshot(
      response({ gps: { time: "not-a-timestamp", latitude: 35, longitude: -81.7 } }),
      VEHICLE_ID
    );
    assert.equal(reading, null);
  });

  test("missing timestamp -> null", () => {
    const reading = normalizeVehicleGpsSnapshot(
      response({ gps: { latitude: 35, longitude: -81.7 } }),
      VEHICLE_ID
    );
    assert.equal(reading, null);
  });

  test("requested vehicle missing from data array -> null, never another vehicle's reading", () => {
    const reading = normalizeVehicleGpsSnapshot(response(), "999999999999999");
    assert.equal(reading, null);
  });

  test("optional fields default to null when absent, required fields still normalize", () => {
    const reading = normalizeVehicleGpsSnapshot(
      response({ name: undefined, gps: { time: "2026-07-22T01:33:34Z", latitude: 35, longitude: -81.7 } }),
      VEHICLE_ID
    );
    assert.deepEqual(reading, {
      providerVehicleId: VEHICLE_ID,
      vehicleName: null,
      latitude: 35,
      longitude: -81.7,
      observedAt: "2026-07-22T01:33:34Z",
      headingDegrees: null,
      speedMilesPerHour: null,
      isEcuSpeed: null,
      formattedLocation: null,
    });
  });
});

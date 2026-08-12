/**
 * Targeted tests for the Phase 6B.2 DriverObservation collector
 * (lib/driverContext/captureObservation.ts).
 *
 * All provider-facing dependencies (driver/driverEvent/observation Prisma
 * clients, isPilotDriver, and the assemble* functions) are faked in-memory —
 * no real database or provider network call is made. assemble*Fn fakes
 * return the same {field, detail} shape the real assemble.ts functions
 * produce, so this file is exercising captureObservation.ts's own
 * validation/mapping/persistence logic, not assemble.ts (which already has
 * its own tests).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildDriverObservationSnapshot,
  captureDriverObservation,
  type CaptureDriverObservationDeps,
  type DriverObservationContext,
} from "../captureObservation";
import type { HosDetail, VehicleLocation, WeatherDetail, ZoneDetail, DriverContext } from "../types";

const NOW_ISO = "2026-08-12T14:22:00.000Z";

function fakeLocationDetail(overrides: Partial<VehicleLocation> = {}): VehicleLocation {
  return {
    latitude: 40.3,
    longitude: -74.5,
    observedAt: NOW_ISO,
    fetchedAt: NOW_ISO,
    provider: "samsara",
    providerVehicleId: "veh-1",
    vehicleIdSource: "provider_mapping",
    state: "fresh",
    source: "vehicle_stats",
    ...overrides,
  };
}

function fakeWeatherDetail(overrides: Partial<WeatherDetail> = {}): WeatherDetail {
  return {
    weatherRisk: 2,
    status: "available",
    origin: "observed",
    provider: "openweather",
    observedAt: NOW_ISO,
    fetchedAt: NOW_ISO,
    latitude: 40.3,
    longitude: -74.5,
    locationState: "fresh",
    locationObservedAt: NOW_ISO,
    conditionSummary: "clear sky",
    ...overrides,
  };
}

function fakeHosDetail(overrides: Partial<HosDetail> = {}): HosDetail {
  return {
    drivingHoursUsed: null,
    drivingHoursRemaining: 8,
    shiftHoursUsed: 3.5,
    status: "available",
    source: "samsara",
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function fakeZoneDetail(overrides: Partial<ZoneDetail> = {}): ZoneDetail {
  return {
    zoneRisk: 4,
    zoneName: "Port Corridor",
    zoneType: "port",
    zoneExplanation: "High congestion corridor",
    availability: "matched",
    explanation: "Inside a monitored risk zone",
    status: "available",
    origin: "observed",
    provider: "internal_geofence",
    observedAt: NOW_ISO,
    fetchedAt: NOW_ISO,
    latitude: 40.3,
    longitude: -74.5,
    locationState: "fresh",
    locationObservedAt: NOW_ISO,
    matchedZoneId: "zone-1",
    distanceMiles: 0.4,
    ...overrides,
  };
}

/** Happy-path fakes: every provider returns a live, available reading. */
function makeHappyDeps(overrides: Partial<CaptureDriverObservationDeps> = {}): {
  deps: CaptureDriverObservationDeps;
  createCalls: unknown[];
} {
  const createCalls: unknown[] = [];

  const deps: CaptureDriverObservationDeps = {
    driverClient: {
      async findUnique({ where }) {
        return where.id === "driver-1" ? { id: "driver-1" } : null;
      },
    },
    driverEventClient: {
      async findUnique({ where }) {
        if (where.id === "event-1") return { driverId: "driver-1" };
        if (where.id === "event-other-driver") return { driverId: "driver-2" };
        return null;
      },
    },
    observationClient: {
      async create(args) {
        createCalls.push(args.data);
        return { id: "obs-1" };
      },
    },
    isPilotDriver: async () => true,
    assembleLocationFn: async () => ({
      field: { value: { latitude: 40.3, longitude: -74.5 }, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["location"],
      detail: fakeLocationDetail(),
    }),
    assembleWeatherFn: async () => ({
      field: { value: 2, origin: "observed", state: "fresh", provider: "openweather", observedAt: NOW_ISO } as DriverContext["weather"],
      detail: fakeWeatherDetail(),
    }),
    assembleZoneRiskFn: async () => ({
      field: { value: 4, origin: "observed", state: "fresh", provider: "internal_geofence", observedAt: NOW_ISO } as DriverContext["zoneRisk"],
      detail: fakeZoneDetail(),
    }),
    assembleHosFn: async () => ({
      field: { value: 3.5, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["hos"],
      detail: fakeHosDetail(),
    }),
    assembleSpeedFn: () => ({
      field: { value: 55, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["speed"],
    }),
    ...overrides,
  };

  return { deps, createCalls };
}

describe("buildDriverObservationSnapshot — successful capture", () => {
  test("interval trigger, all inputs available: scalar fields and contextJson are populated", async () => {
    const { deps } = makeHappyDeps();
    const snapshot = await buildDriverObservationSnapshot(
      { driverId: "driver-1", triggerType: "interval" },
      deps
    );

    assert.equal(snapshot.driverId, "driver-1");
    assert.equal(snapshot.triggerType, "interval");
    assert.equal(snapshot.driverEventId, null);
    assert.equal(snapshot.observedAt, snapshot.collectedAt, "observedAt and collectedAt must be the same collection instant");
    assert.equal(snapshot.latitude, 40.3);
    assert.equal(snapshot.longitude, -74.5);
    assert.equal(snapshot.speedMph, 55);
    assert.equal(snapshot.hosShiftHoursUsed, 3.5);
    assert.equal(snapshot.weatherRisk, 2);
    assert.equal(snapshot.zoneRisk, 4);
  });

  test("contextJson retains the full provenance detail objects, not just the scalar values", async () => {
    const { deps } = makeHappyDeps();
    const snapshot = await buildDriverObservationSnapshot(
      { driverId: "driver-1", triggerType: "interval" },
      deps
    );

    const ctx: DriverObservationContext = snapshot.contextJson;
    assert.deepEqual(ctx.location, fakeLocationDetail());
    assert.deepEqual(ctx.weather, fakeWeatherDetail());
    assert.deepEqual(ctx.hos, fakeHosDetail());
    assert.deepEqual(ctx.zone, fakeZoneDetail());
    assert.equal(ctx.speed.value, 55);
    assert.equal(ctx.speed.state, "fresh");
    assert.equal(ctx.speed.provider, "samsara");
  });
});

describe("buildDriverObservationSnapshot — unavailable inputs stay null, never defaulted", () => {
  test("location/speed/weather/hos/zone all unavailable -> scalar fields are null, not 0", async () => {
    const { deps } = makeHappyDeps({
      assembleLocationFn: async () => ({
        field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null } as DriverContext["location"],
        detail: fakeLocationDetail({ latitude: null, longitude: null, state: "unavailable", provider: null, observedAt: null, source: "none" }),
      }),
      assembleWeatherFn: async () => ({
        field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null } as DriverContext["weather"],
        detail: fakeWeatherDetail({ weatherRisk: null, status: "unavailable", origin: null, provider: null, observedAt: null, conditionSummary: null }),
      }),
      assembleZoneRiskFn: async () => ({
        field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null } as DriverContext["zoneRisk"],
        detail: fakeZoneDetail({ zoneRisk: null, availability: "location_unavailable", status: "unavailable", origin: null, provider: null, observedAt: null, matchedZoneId: null, distanceMiles: null }),
      }),
      assembleHosFn: async () => ({
        field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null } as DriverContext["hos"],
        detail: fakeHosDetail({ shiftHoursUsed: null, drivingHoursRemaining: null, status: "unavailable", source: "none", updatedAt: null }),
      }),
      assembleSpeedFn: () => ({
        field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null } as DriverContext["speed"],
      }),
    });

    const snapshot = await buildDriverObservationSnapshot(
      { driverId: "driver-1", triggerType: "interval" },
      deps
    );

    assert.equal(snapshot.latitude, null);
    assert.equal(snapshot.longitude, null);
    assert.equal(snapshot.speedMph, null);
    assert.equal(snapshot.hosShiftHoursUsed, null);
    assert.equal(snapshot.weatherRisk, null);
    assert.equal(snapshot.zoneRisk, null);

    // Never fabricated as 0 — explicitly not equal to the "looks unavailable
    // but is actually a real zero reading" case.
    assert.notEqual(snapshot.speedMph, 0);
    assert.notEqual(snapshot.hosShiftHoursUsed, 0);

    // Unavailability itself is preserved in contextJson, not just implied
    // by a null scalar.
    assert.equal(snapshot.contextJson.location.state, "unavailable");
    assert.equal(snapshot.contextJson.weather.status, "unavailable");
    assert.equal(snapshot.contextJson.hos.status, "unavailable");
    assert.equal(snapshot.contextJson.zone.status, "unavailable");
  });

  test("a real zero zoneRisk reading (outside_monitored_zones) is preserved as 0, not confused with unavailable", async () => {
    const { deps } = makeHappyDeps({
      assembleZoneRiskFn: async () => ({
        field: { value: 0, origin: "observed", state: "fresh", provider: "internal_geofence", observedAt: NOW_ISO } as DriverContext["zoneRisk"],
        detail: fakeZoneDetail({ zoneRisk: 0, zoneName: null, zoneType: null, zoneExplanation: null, availability: "outside_monitored_zones", status: "available", matchedZoneId: null, distanceMiles: null }),
      }),
    });

    const snapshot = await buildDriverObservationSnapshot(
      { driverId: "driver-1", triggerType: "interval" },
      deps
    );

    assert.equal(snapshot.zoneRisk, 0);
    assert.equal(snapshot.contextJson.zone.availability, "outside_monitored_zones");
    assert.equal(snapshot.contextJson.zone.status, "available");
  });
});

describe("buildDriverObservationSnapshot — validation", () => {
  test("unknown driverId is rejected", async () => {
    const { deps } = makeHappyDeps();
    await assert.rejects(
      buildDriverObservationSnapshot({ driverId: "no-such-driver", triggerType: "interval" }, deps),
      /No Driver found/
    );
  });

  test("driverEventId belonging to a different driver is rejected", async () => {
    const { deps } = makeHappyDeps();
    await assert.rejects(
      buildDriverObservationSnapshot(
        { driverId: "driver-1", triggerType: "safety_event", driverEventId: "event-other-driver" },
        deps
      ),
      /belongs to driverId="driver-2"/
    );
  });

  test("unknown driverEventId is rejected", async () => {
    const { deps } = makeHappyDeps();
    await assert.rejects(
      buildDriverObservationSnapshot(
        { driverId: "driver-1", triggerType: "safety_event", driverEventId: "no-such-event" },
        deps
      ),
      /No DriverEvent found/
    );
  });

  test("interval trigger with a driverEventId is rejected", async () => {
    const { deps } = makeHappyDeps();
    await assert.rejects(
      buildDriverObservationSnapshot(
        { driverId: "driver-1", triggerType: "interval", driverEventId: "event-1" },
        deps
      ),
      /must not include a driverEventId/
    );
  });
});

describe("buildDriverObservationSnapshot — trigger types", () => {
  test("interval trigger works without a driverEventId", async () => {
    const { deps } = makeHappyDeps();
    const snapshot = await buildDriverObservationSnapshot(
      { driverId: "driver-1", triggerType: "interval" },
      deps
    );
    assert.equal(snapshot.triggerType, "interval");
    assert.equal(snapshot.driverEventId, null);
  });

  test("safety_event trigger stores the event relation correctly", async () => {
    const { deps } = makeHappyDeps();
    const snapshot = await buildDriverObservationSnapshot(
      { driverId: "driver-1", triggerType: "safety_event", driverEventId: "event-1" },
      deps
    );
    assert.equal(snapshot.triggerType, "safety_event");
    assert.equal(snapshot.driverEventId, "event-1");
  });
});

describe("captureDriverObservation — persistence", () => {
  test("writes the snapshot's exact fields to the observation client", async () => {
    const { deps, createCalls } = makeHappyDeps();
    const result = await captureDriverObservation(
      { driverId: "driver-1", triggerType: "safety_event", driverEventId: "event-1" },
      deps
    );

    assert.equal(result.id, "obs-1");
    assert.equal(createCalls.length, 1);
    const written = createCalls[0] as Record<string, unknown>;
    assert.equal(written.driverId, "driver-1");
    assert.equal(written.triggerType, "safety_event");
    assert.equal(written.driverEventId, "event-1");
    assert.equal(written.latitude, 40.3);
    assert.equal(written.zoneRisk, 4);
    assert.ok(written.observedAt instanceof Date);
    assert.ok(written.collectedAt instanceof Date);
  });

  test("a database failure on create() propagates rather than being swallowed", async () => {
    const { deps } = makeHappyDeps({
      observationClient: {
        async create() {
          throw new Error("connection lost");
        },
      },
    });

    await assert.rejects(
      captureDriverObservation({ driverId: "driver-1", triggerType: "interval" }, deps),
      /connection lost/
    );
  });
});

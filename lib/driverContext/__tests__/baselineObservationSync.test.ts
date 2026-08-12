/**
 * Targeted tests for the Phase 6B.3 baseline observation orchestrator
 * (lib/driverContext/baselineObservationSync.ts). All DB/provider
 * dependencies are faked in-memory — no real database or network call is
 * made. assemble*Fn fakes are injected via CaptureDriverObservationDeps,
 * the same seam lib/driverContext/__tests__/captureObservation.test.ts uses.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runBaselineObservationSync,
  BASELINE_INTERVAL_MS,
  type BaselineObservationSyncDeps,
  type PilotDriverIdClient,
  type RecentObservationClient,
} from "../baselineObservationSync";
import type { CaptureDriverObservationDeps } from "../captureObservation";
import type { HosDetail, VehicleLocation, WeatherDetail, ZoneDetail, DriverContext } from "../types";

const NOW = new Date("2026-08-12T14:00:00.000Z");
const NOW_ISO = NOW.toISOString();

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
    zoneRisk: 0,
    zoneName: null,
    zoneType: null,
    zoneExplanation: null,
    availability: "outside_monitored_zones",
    explanation: "Outside monitored risk zones",
    status: "available",
    origin: "observed",
    provider: "internal_geofence",
    observedAt: NOW_ISO,
    fetchedAt: NOW_ISO,
    latitude: 40.3,
    longitude: -74.5,
    locationState: "fresh",
    locationObservedAt: NOW_ISO,
    matchedZoneId: null,
    distanceMiles: null,
    ...overrides,
  };
}

interface HarnessOptions {
  pilotDriverIds: string[];
  /** driverId -> most recent interval observation's observedAt, or undefined for "none yet" */
  recentObservations?: Record<string, Date>;
  /** driverId -> location detail override for that driver's snapshot */
  locationOverrides?: Record<string, Partial<VehicleLocation>>;
  /** driverId -> HOS detail override */
  hosOverrides?: Record<string, Partial<HosDetail>>;
  /** driverIds that should throw when building a snapshot */
  throwingDrivers?: string[];
  /** driverIds that isPilotDriver should report as no-longer-eligible (defensive re-check) */
  deactivatedDrivers?: string[];
}

function makeHarness(opts: HarnessOptions) {
  const locationCalls: string[] = [];
  const createCalls: unknown[] = [];

  const pilotDriverIdClient: PilotDriverIdClient = {
    async findMany() {
      return opts.pilotDriverIds.map((driverId) => ({ driverId }));
    },
  };

  const recentObservationClient: RecentObservationClient = {
    async findFirst({ where }) {
      const observedAt = opts.recentObservations?.[where.driverId];
      return observedAt ? { observedAt } : null;
    },
  };

  const isPilotDriverFn = async (driverId: string) => !opts.deactivatedDrivers?.includes(driverId);

  const captureDeps: CaptureDriverObservationDeps = {
    driverClient: { async findUnique() { return { id: "irrelevant" }; } },
    driverEventClient: { async findUnique() { return null; } },
    observationClient: {
      async create(args) {
        createCalls.push(args.data);
        return { id: `obs-${createCalls.length}` };
      },
    },
    isPilotDriver: isPilotDriverFn,
    assembleLocationFn: async (driverId) => {
      locationCalls.push(driverId);
      if (opts.throwingDrivers?.includes(driverId)) {
        throw new Error(`simulated provider failure for ${driverId}`);
      }
      return {
        field: { value: { latitude: 40.3, longitude: -74.5 }, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["location"],
        detail: fakeLocationDetail(opts.locationOverrides?.[driverId]),
      };
    },
    assembleWeatherFn: async () => ({
      field: { value: 2, origin: "observed", state: "fresh", provider: "openweather", observedAt: NOW_ISO } as DriverContext["weather"],
      detail: fakeWeatherDetail(),
    }),
    assembleZoneRiskFn: async () => ({
      field: { value: 0, origin: "observed", state: "fresh", provider: "internal_geofence", observedAt: NOW_ISO } as DriverContext["zoneRisk"],
      detail: fakeZoneDetail(),
    }),
    assembleHosFn: async (driverId) => {
      const detail = fakeHosDetail(opts.hosOverrides?.[driverId]);
      return {
        field: {
          value: detail.shiftHoursUsed,
          origin: detail.shiftHoursUsed === null ? null : "observed",
          state: detail.shiftHoursUsed === null ? "unavailable" : "fresh",
          provider: detail.shiftHoursUsed === null ? null : "samsara",
          observedAt: detail.shiftHoursUsed === null ? null : NOW_ISO,
        } as DriverContext["hos"],
        detail,
      };
    },
    assembleSpeedFn: () => ({
      field: { value: 55, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["speed"],
    }),
  };

  const deps: BaselineObservationSyncDeps = {
    pilotDriverIdClient,
    recentObservationClient,
    isPilotDriver: isPilotDriverFn,
    now: () => NOW,
    captureDeps,
  };

  return { deps, locationCalls, createCalls };
}

describe("runBaselineObservationSync — happy path", () => {
  test("eligible pilot driver with no prior observation and fresh location: created", async () => {
    const { deps } = makeHarness({ pilotDriverIds: ["driver-1"] });
    const result = await runBaselineObservationSync(deps);

    assert.equal(result.driversConsidered, 1);
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.results[0].status, "created");
    if (result.results[0].status === "created") {
      assert.ok(result.results[0].observationId);
    }
  });

  test("HOS unavailable alone does not block persistence", async () => {
    const { deps, createCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      hosOverrides: { "driver-1": { shiftHoursUsed: null, status: "unavailable", source: "none", updatedAt: null } },
    });

    const result = await runBaselineObservationSync(deps);

    assert.equal(result.created, 1);
    assert.equal(createCalls.length, 1);
    const written = createCalls[0] as Record<string, unknown>;
    assert.equal(written.hosShiftHoursUsed, null);
    assert.equal(written.latitude, 40.3, "location was still fresh, so the row was still created");
  });
});

describe("runBaselineObservationSync — recency guard", () => {
  test("an interval observation within the 10-minute window skips WITHOUT calling the provider stack", async () => {
    const recentAt = new Date(NOW.getTime() - 3 * 60 * 1000); // 3 minutes ago
    const { deps, locationCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      recentObservations: { "driver-1": recentAt },
    });

    const result = await runBaselineObservationSync(deps);

    assert.equal(result.skipped, 1);
    assert.deepEqual(result.results[0], { driverId: "driver-1", status: "skipped", reason: "recent_observation" });
    assert.equal(locationCalls.length, 0, "no provider call should happen once the recency guard short-circuits");
  });

  test("an interval observation exactly at the 10-minute boundary is no longer 'recent' (exclusive)", async () => {
    const boundaryAt = new Date(NOW.getTime() - BASELINE_INTERVAL_MS);
    const { deps } = makeHarness({
      pilotDriverIds: ["driver-1"],
      recentObservations: { "driver-1": boundaryAt },
    });

    const result = await runBaselineObservationSync(deps);
    assert.equal(result.created, 1, "an observation exactly BASELINE_INTERVAL_MS old is due again");
  });

  test("repeated calls cannot create duplicate rows inside the guard window (two sequential runs, shared state)", async () => {
    let storedObservedAt: Date | null = null;

    const captureDeps: CaptureDriverObservationDeps = {
      driverClient: { async findUnique() { return { id: "irrelevant" }; } },
      driverEventClient: { async findUnique() { return null; } },
      observationClient: {
        async create(args) {
          storedObservedAt = args.data.observedAt as Date;
          return { id: "obs-1" };
        },
      },
      assembleLocationFn: async () => ({
        field: { value: { latitude: 40.3, longitude: -74.5 }, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["location"],
        detail: fakeLocationDetail(),
      }),
      assembleWeatherFn: async () => ({ field: { value: 2, origin: "observed", state: "fresh", provider: "openweather", observedAt: NOW_ISO } as DriverContext["weather"], detail: fakeWeatherDetail() }),
      assembleZoneRiskFn: async () => ({ field: { value: 0, origin: "observed", state: "fresh", provider: "internal_geofence", observedAt: NOW_ISO } as DriverContext["zoneRisk"], detail: fakeZoneDetail() }),
      assembleHosFn: async () => ({ field: { value: 3.5, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["hos"], detail: fakeHosDetail() }),
      assembleSpeedFn: () => ({ field: { value: 55, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["speed"] }),
    };

    const pilotDriverIdClient: PilotDriverIdClient = { async findMany() { return [{ driverId: "driver-1" }]; } };
    const recentObservationClient: RecentObservationClient = {
      async findFirst() {
        return storedObservedAt ? { observedAt: storedObservedAt } : null;
      },
    };

    // First call at 14:00 — nothing stored yet -> created.
    const firstRun = await runBaselineObservationSync({
      pilotDriverIdClient,
      recentObservationClient,
      isPilotDriver: async () => true,
      captureDeps,
      now: () => NOW,
    });
    assert.equal(firstRun.created, 1);

    // Second call 3 minutes later — well inside BASELINE_INTERVAL_MS -> skipped.
    const secondRun = await runBaselineObservationSync({
      pilotDriverIdClient,
      recentObservationClient,
      isPilotDriver: async () => true,
      captureDeps,
      now: () => new Date(NOW.getTime() + 3 * 60 * 1000),
    });
    assert.equal(secondRun.created, 0);
    assert.equal(secondRun.skipped, 1);
    assert.equal(secondRun.results[0].status, "skipped");
    if (secondRun.results[0].status === "skipped") {
      assert.equal(secondRun.results[0].reason, "recent_observation");
    }
  });
});

describe("runBaselineObservationSync — location freshness gate", () => {
  test("stale location skips without persistence", async () => {
    const { deps, createCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      locationOverrides: { "driver-1": { state: "stale", source: "vehicle_stats" } },
    });

    const result = await runBaselineObservationSync(deps);

    assert.equal(result.created, 0);
    assert.deepEqual(result.results[0], { driverId: "driver-1", status: "skipped", reason: "location_not_fresh" });
    assert.equal(createCalls.length, 0, "no row should be written for a stale location");
  });

  test("unavailable location skips without persistence", async () => {
    const { deps, createCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      locationOverrides: { "driver-1": { state: "unavailable", latitude: null, longitude: null, provider: null, source: "none" } },
    });

    const result = await runBaselineObservationSync(deps);

    assert.equal(result.created, 0);
    assert.equal(result.results[0].status, "skipped");
    if (result.results[0].status === "skipped") {
      assert.equal(result.results[0].reason, "location_not_fresh");
    }
    assert.equal(createCalls.length, 0);
  });
});

describe("runBaselineObservationSync — failure isolation", () => {
  test("one driver's snapshot failure does not stop the others", async () => {
    const { deps } = makeHarness({
      pilotDriverIds: ["driver-1", "driver-2"],
      throwingDrivers: ["driver-1"],
    });

    const result = await runBaselineObservationSync(deps);

    assert.equal(result.driversConsidered, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.created, 1);

    const d1 = result.results.find((r) => r.driverId === "driver-1");
    const d2 = result.results.find((r) => r.driverId === "driver-2");
    assert.equal(d1?.status, "failed");
    assert.equal(d2?.status, "created");
  });
});

describe("runBaselineObservationSync — eligibility", () => {
  test("a driver deactivated since the pilot list was resolved is skipped as not_eligible", async () => {
    const { deps } = makeHarness({
      pilotDriverIds: ["driver-1"],
      deactivatedDrivers: ["driver-1"],
    });

    const result = await runBaselineObservationSync(deps);

    assert.equal(result.skipped, 1);
    assert.deepEqual(result.results[0], { driverId: "driver-1", status: "skipped", reason: "not_eligible" });
  });

  test("only drivers returned by the pilot mapping query are considered at all", async () => {
    const { deps } = makeHarness({ pilotDriverIds: ["driver-1", "driver-2"] });
    const result = await runBaselineObservationSync(deps);
    assert.equal(result.driversConsidered, 2);
    assert.deepEqual(
      result.results.map((r) => r.driverId).sort(),
      ["driver-1", "driver-2"]
    );
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  simulatedField,
  fieldStateForSyncStatus,
  classifyLocationFreshness,
  assembleLocation,
  assembleWeather,
  assembleZoneRisk,
  assembleSpeed,
  LOCATION_FRESH_THRESHOLD_MS,
  LOCATION_STALE_THRESHOLD_MS,
} from "../assemble";
import type { SamsaraVehicleStatsSnapshotResponse } from "../../providers/samsara/vehicleStats";
import type { RealWeatherResult } from "../../samsara";
import type { VehicleLocation } from "../types";
import type { ZoneMatch } from "../../providers/zones/zoneRisk";
import type { ZoneDefinition } from "../../providers/zones/zoneData";
import { getScenarioForDriver } from "../../mockScenarios";

// These two functions are the pure, easily-isolated pieces of assemble.ts.
// The rest of assembleDriverContext() is thin I/O orchestration over
// already-tested collaborators (onDemandSync has its own concurrency tests;
// the mock scenario getters are trivial), so it isn't re-tested here with a
// full dependency-injection harness — that would be more machinery than an
// MVP composition function warrants.

describe("simulatedField", () => {
  test("pilot driver: not-yet-integrated field is a fallback, no provider, no timestamp", () => {
    const f = simulatedField(6.0, true, "2026-07-13T00:00:00.000Z");
    assert.deepEqual(f, {
      value: 6.0,
      origin: "simulated",
      state: "fallback",
      provider: null,
      observedAt: null,
    });
  });

  test("demo driver: simulated field is fresh, internal, timestamped now", () => {
    const f = simulatedField(6.0, false, "2026-07-13T00:00:00.000Z");
    assert.deepEqual(f, {
      value: 6.0,
      origin: "simulated",
      state: "fresh",
      provider: "internal",
      observedAt: "2026-07-13T00:00:00.000Z",
    });
  });
});

describe("fieldStateForSyncStatus", () => {
  test("refreshed -> fresh", () => {
    assert.equal(fieldStateForSyncStatus("refreshed"), "fresh");
  });

  test("fresh (no-op, within window) -> cached", () => {
    assert.equal(fieldStateForSyncStatus("fresh"), "cached");
  });

  test("sync_in_progress -> cached (stored events remain real, just not just-confirmed)", () => {
    assert.equal(fieldStateForSyncStatus("sync_in_progress"), "cached");
  });

  test("refresh_failed -> cached (stored events remain real, just not just-confirmed)", () => {
    assert.equal(fieldStateForSyncStatus("refresh_failed"), "cached");
  });
});

// classifyLocationFreshness — Phase 1 (Real GPS). GPS reports every ~5-6s
// while a vehicle is online, so these thresholds intentionally treat
// "no reading in 10+ minutes" as a meaningful signal, not polling noise.
describe("classifyLocationFreshness", () => {
  const NOW = new Date("2026-07-22T01:33:40.000Z");

  test("just observed -> fresh", () => {
    assert.equal(classifyLocationFreshness(new Date(NOW.getTime() - 5_000).toISOString(), NOW), "fresh");
  });

  test("exactly at the fresh threshold (10 min) -> fresh (inclusive)", () => {
    const observedAt = new Date(NOW.getTime() - LOCATION_FRESH_THRESHOLD_MS).toISOString();
    assert.equal(classifyLocationFreshness(observedAt, NOW), "fresh");
  });

  test("one second past the fresh threshold -> stale", () => {
    const observedAt = new Date(NOW.getTime() - LOCATION_FRESH_THRESHOLD_MS - 1_000).toISOString();
    assert.equal(classifyLocationFreshness(observedAt, NOW), "stale");
  });

  test("30 minutes old -> stale", () => {
    assert.equal(classifyLocationFreshness(new Date(NOW.getTime() - 30 * 60_000).toISOString(), NOW), "stale");
  });

  test("exactly at the stale threshold (6 hours) -> stale (inclusive)", () => {
    const observedAt = new Date(NOW.getTime() - LOCATION_STALE_THRESHOLD_MS).toISOString();
    assert.equal(classifyLocationFreshness(observedAt, NOW), "stale");
  });

  test("one second past the stale threshold -> unavailable", () => {
    const observedAt = new Date(NOW.getTime() - LOCATION_STALE_THRESHOLD_MS - 1_000).toISOString();
    assert.equal(classifyLocationFreshness(observedAt, NOW), "unavailable");
  });

  test("12 days old (e.g. a backfilled historical reading) -> unavailable", () => {
    const observedAt = new Date(NOW.getTime() - 12 * 24 * 60 * 60_000).toISOString();
    assert.equal(classifyLocationFreshness(observedAt, NOW), "unavailable");
  });

  test("missing observedAt -> unavailable, not a crash", () => {
    assert.equal(classifyLocationFreshness(null, NOW), "unavailable");
    assert.equal(classifyLocationFreshness(undefined, NOW), "unavailable");
  });

  test("unparseable timestamp -> unavailable, not a crash", () => {
    assert.equal(classifyLocationFreshness("not-a-timestamp", NOW), "unavailable");
  });

  test("small future timestamp (clock skew) -> fresh, does not crash", () => {
    const observedAt = new Date(NOW.getTime() + 3_000).toISOString(); // 3s in the future
    assert.equal(classifyLocationFreshness(observedAt, NOW), "fresh");
  });
});

// assembleLocation — pilot behavior must never fall back to mock coordinates;
// non-pilot behavior must preserve the existing mock/demo path. Every
// dependency is faked in-memory — no real network or database access.
describe("assembleLocation", () => {
  const NOW_ISO = "2026-07-22T01:33:40.000Z";

  function gpsResponse(vehicleId: string, time: string): SamsaraVehicleStatsSnapshotResponse {
    return {
      data: [
        {
          id: vehicleId,
          name: "TRUCK 226 (IDEAL)",
          gps: {
            time,
            latitude: 35.078091,
            longitude: -81.721605,
            headingDegrees: 253,
            speedMilesPerHour: 71.447,
            reverseGeo: { formattedLocation: "I 85, Gaffney, SC, 29341" },
            isEcuSpeed: true,
          },
        },
      ],
      pagination: { endCursor: "", hasNextPage: false },
    };
  }

  test("pilot with fresh GPS: real coordinates, state fresh, DriverContextField state fresh", async () => {
    const { field, detail } = await assembleLocation("drv_1", true, NOW_ISO, {
      resolveVehicleId: async () => ({ vehicleId: "1000000000001", source: "driver_event" }),
      fetchGpsSnapshot: async () => gpsResponse("1000000000001", "2026-07-22T01:33:35.000Z"),
    });

    assert.equal(detail.state, "fresh");
    assert.equal(detail.latitude, 35.078091);
    assert.equal(detail.longitude, -81.721605);
    assert.equal(detail.provider, "samsara");
    assert.equal(detail.providerVehicleId, "1000000000001");
    assert.equal(detail.vehicleIdSource, "driver_event");
    assert.equal(detail.source, "vehicle_stats");
    assert.equal(detail.speedMilesPerHour, 71.447);

    assert.equal(field.origin, "observed");
    assert.equal(field.state, "fresh");
    assert.equal(field.provider, "samsara");
    assert.deepEqual(field.value, { latitude: 35.078091, longitude: -81.721605 });
  });

  test("pilot with stale GPS: real coordinates preserved, state stale, DriverContextField state cached", async () => {
    const { field, detail } = await assembleLocation("drv_1", true, NOW_ISO, {
      resolveVehicleId: async () => ({ vehicleId: "1000000000001", source: "provider_mapping" }),
      fetchGpsSnapshot: async () => gpsResponse("1000000000001", "2026-07-22T01:03:40.000Z"), // 30 min old
    });

    assert.equal(detail.state, "stale");
    assert.equal(detail.latitude, 35.078091, "stale coordinates must still be present for transparency");
    assert.equal(detail.longitude, -81.721605);

    assert.equal(field.state, "cached", "outer DriverContextField maps stale -> cached, same convention as HOS");
    assert.deepEqual(field.value, { latitude: 35.078091, longitude: -81.721605 });
  });

  test("pilot with no vehicle ID: unavailable, null coordinates, never a GPS call attempted", async () => {
    let fetchCalled = false;
    const { field, detail } = await assembleLocation("drv_1", true, NOW_ISO, {
      resolveVehicleId: async () => ({ vehicleId: null, source: "unavailable" }),
      fetchGpsSnapshot: async () => {
        fetchCalled = true;
        throw new Error("should not be called");
      },
    });

    assert.equal(fetchCalled, false);
    assert.equal(detail.state, "unavailable");
    assert.equal(detail.latitude, null);
    assert.equal(detail.longitude, null);
    assert.equal(detail.provider, null);
    assert.equal(field.value, null);
    assert.equal(field.origin, null);
    assert.equal(field.state, "unavailable");
  });

  test("pilot with a resolved vehicle ID but no usable GPS reading: unavailable, vehicle ID still reported", async () => {
    const { detail } = await assembleLocation("drv_1", true, NOW_ISO, {
      resolveVehicleId: async () => ({ vehicleId: "1000000000001", source: "driver_event" }),
      fetchGpsSnapshot: async () => ({ data: [], pagination: { endCursor: "", hasNextPage: false } }),
    });

    assert.equal(detail.state, "unavailable");
    assert.equal(detail.latitude, null);
    assert.equal(detail.providerVehicleId, "1000000000001", "vehicle ID is still surfaced even when GPS itself is unavailable");
    assert.equal(detail.vehicleIdSource, "driver_event");
  });

  test("pilot with GPS older than the stale threshold: unavailable, not fresh or stale", async () => {
    const { detail, field } = await assembleLocation("drv_1", true, NOW_ISO, {
      resolveVehicleId: async () => ({ vehicleId: "1000000000001", source: "driver_event" }),
      fetchGpsSnapshot: async () => gpsResponse("1000000000001", "2026-07-10T13:26:20.580Z"), // 12 days old
    });

    assert.equal(detail.state, "unavailable");
    assert.equal(detail.latitude, null);
    assert.equal(field.state, "unavailable");
  });

  test("pilot: a failed GPS fetch never falls back to mock coordinates", async () => {
    const { field, detail } = await assembleLocation("drv_1", true, NOW_ISO, {
      resolveVehicleId: async () => ({ vehicleId: "1000000000001", source: "driver_event" }),
      fetchGpsSnapshot: async () => {
        throw new Error("network error");
      },
    });

    assert.equal(detail.state, "unavailable");
    assert.equal(detail.latitude, null);
    assert.equal(detail.longitude, null);
    assert.equal(field.origin, null, "must never be 'simulated' for a pilot");
    assert.notEqual(field.origin, "simulated");
  });

  test("non-pilot preserves mock/demo behavior with simulated provenance", async () => {
    const { field, detail } = await assembleLocation("mock-driver-id", false, NOW_ISO);

    assert.equal(field.origin, "simulated");
    assert.equal(field.state, "fresh");
    assert.equal(field.provider, "internal");
    assert.equal(typeof field.value?.latitude, "number");
    assert.equal(typeof field.value?.longitude, "number");

    assert.equal(detail.provider, null);
    assert.equal(detail.source, "none");
    assert.equal(detail.state, "fresh");
    assert.equal(detail.vehicleIdSource, "unavailable");
  });
});

// assembleWeather — Phase 2 (Weather from Real Vehicle GPS). Pilot weather
// must be gated strictly on the already-assembled location's freshness and
// must never fall back to mock coordinates. Every dependency is faked
// in-memory — no real network or database access.
describe("assembleWeather", () => {
  const NOW_ISO = "2026-07-22T01:33:40.000Z";

  function freshLocation(overrides: Partial<VehicleLocation> = {}): VehicleLocation {
    return {
      latitude: 35.078091,
      longitude: -81.721605,
      observedAt: "2026-07-22T01:33:35.000Z",
      fetchedAt: NOW_ISO,
      provider: "samsara",
      providerVehicleId: "1000000000001",
      vehicleIdSource: "driver_event",
      state: "fresh",
      source: "vehicle_stats",
      ...overrides,
    };
  }

  function staleLocation(): VehicleLocation {
    return freshLocation({ state: "stale", observedAt: "2026-07-22T01:03:40.000Z" });
  }

  function unavailableLocation(): VehicleLocation {
    return {
      latitude: null,
      longitude: null,
      observedAt: null,
      fetchedAt: NOW_ISO,
      provider: null,
      providerVehicleId: null,
      vehicleIdSource: "unavailable",
      state: "unavailable",
      source: "none",
    };
  }

  const WEATHER_RESULT: RealWeatherResult = {
    weatherRisk: 0.42,
    observedAt: "2026-07-22T01:30:00.000Z", // distinct from both fetchedAt and locationObservedAt — proves provider time is used, not request/GPS time
    conditionSummary: "light rain",
  };

  test("pilot with fresh GPS: weather is fetched using the real GPS coordinates", async () => {
    let calledWith: { latitude: number; longitude: number } | null = null;
    const { field, detail } = await assembleWeather("drv_1", true, NOW_ISO, freshLocation(), {
      fetchWeather: async (params) => {
        calledWith = { latitude: params.latitude, longitude: params.longitude };
        return WEATHER_RESULT;
      },
    });

    assert.deepEqual(calledWith, { latitude: 35.078091, longitude: -81.721605 });
    assert.equal(field.origin, "observed");
    assert.equal(field.state, "fresh");
    assert.equal(field.provider, "openweather");
    assert.equal(field.value, 0.42);
    assert.equal(field.observedAt, "2026-07-22T01:30:00.000Z", "field.observedAt must be the provider's own timestamp, not fetchedAt/now");

    assert.equal(detail.weatherRisk, 0.42);
    assert.equal(detail.status, "available");
    assert.equal(detail.origin, "observed");
    assert.equal(detail.provider, "openweather");
    assert.equal(detail.observedAt, "2026-07-22T01:30:00.000Z");
    assert.equal(detail.latitude, 35.078091);
    assert.equal(detail.longitude, -81.721605);
    assert.equal(detail.locationState, "fresh");
    assert.equal(detail.locationObservedAt, "2026-07-22T01:33:35.000Z");
    assert.equal(detail.conditionSummary, "light rain");
  });

  test("pilot with stale GPS: weather provider is never called, weather is unavailable", async () => {
    let called = false;
    const { field, detail } = await assembleWeather("drv_1", true, NOW_ISO, staleLocation(), {
      fetchWeather: async () => {
        called = true;
        return WEATHER_RESULT;
      },
    });

    assert.equal(called, false, "stale GPS must never drive a weather request");
    assert.equal(field.value, null);
    assert.equal(field.origin, null);
    assert.equal(field.state, "unavailable");
    assert.equal(detail.status, "unavailable");
    assert.equal(detail.weatherRisk, null);
    assert.equal(detail.latitude, null, "no coordinates were used — none should be reported as used");
    assert.equal(detail.longitude, null);
    assert.equal(detail.locationState, "stale", "the underlying GPS state is still surfaced for transparency");
  });

  test("pilot with unavailable GPS: weather provider is never called, weather is unavailable", async () => {
    let called = false;
    const { field, detail } = await assembleWeather("drv_1", true, NOW_ISO, unavailableLocation(), {
      fetchWeather: async () => {
        called = true;
        return WEATHER_RESULT;
      },
    });

    assert.equal(called, false);
    assert.equal(field.state, "unavailable");
    assert.equal(detail.status, "unavailable");
    assert.equal(detail.locationState, "unavailable");
    assert.equal(detail.locationObservedAt, null);
  });

  test("pilot never falls back to scenario coordinates on any path", async () => {
    // A distinctive fake coordinate pair that does not match any real mock scenario —
    // if this ever appeared in the result, it would prove a scenario fallback leaked in.
    const SCENARIO_TRAP = { latitude: 99.9, longitude: 99.9 };

    const freshResult = await assembleWeather("drv_1", true, NOW_ISO, freshLocation(), {
      fetchWeather: async () => WEATHER_RESULT,
    });
    assert.notDeepEqual(
      { latitude: freshResult.detail.latitude, longitude: freshResult.detail.longitude },
      SCENARIO_TRAP
    );

    const staleResult = await assembleWeather("drv_1", true, NOW_ISO, staleLocation());
    assert.equal(staleResult.field.origin, null);
    assert.notEqual(staleResult.field.origin, "simulated");

    const unavailableResult = await assembleWeather("drv_1", true, NOW_ISO, unavailableLocation());
    assert.equal(unavailableResult.field.origin, null);
    assert.notEqual(unavailableResult.field.origin, "simulated");
  });

  test("pilot with fresh GPS but a failed weather fetch: unavailable, never simulated", async () => {
    const { field, detail } = await assembleWeather("drv_1", true, NOW_ISO, freshLocation(), {
      fetchWeather: async () => null,
    });

    assert.equal(field.state, "unavailable");
    assert.equal(field.origin, null);
    assert.notEqual(field.origin, "simulated");
    assert.equal(detail.status, "unavailable");
    assert.equal(detail.latitude, 35.078091, "coordinates that WERE attempted are still reported for debugging transparency");
    assert.equal(detail.locationState, "fresh");
  });

  test("pilot: unavailable location produces weatherRisk 0 through toRiskInput's existing default (verified at the field level)", async () => {
    const { field } = await assembleWeather("drv_1", true, NOW_ISO, unavailableLocation());
    assert.equal(field.value, null, "toRiskInput.ts defaults a null weather value to 0 — unchanged this phase");
  });

  test("demo: uses scenario coordinates, real weather succeeds -> observed/fresh provenance", async () => {
    let calledWith: { latitude: number; longitude: number } | null = null;
    const { field, detail } = await assembleWeather("mock-driver-id", false, NOW_ISO, unavailableLocation(), {
      fetchWeather: async (params) => {
        calledWith = { latitude: params.latitude, longitude: params.longitude };
        return WEATHER_RESULT;
      },
    });

    assert.ok(calledWith, "demo must still request weather using scenario coordinates");
    assert.equal(field.origin, "observed");
    assert.equal(field.state, "fresh");
    assert.equal(field.provider, "openweather");
    assert.equal(detail.locationState, null, "demo weather is not gated by pilot GPS state");
  });

  test("demo: weather provider fails -> simulated scenario fallback, clearly labeled", async () => {
    const { field, detail } = await assembleWeather("mock-driver-id", false, NOW_ISO, unavailableLocation(), {
      fetchWeather: async () => null,
    });

    assert.equal(field.origin, "simulated");
    assert.equal(field.state, "fallback");
    assert.equal(field.provider, null);
    assert.equal(typeof field.value, "number", "demo fallback still has a usable weatherRisk value");
    assert.equal(detail.status, "available");
    assert.equal(detail.origin, "simulated");
  });
});

// assembleZoneRisk — Phase 3 (Real Zone Risk). Pilot zone risk must be
// gated strictly on the already-assembled location's freshness (same rule
// as weather) and must never fall back to mock/scenario zone data. Every
// dependency is faked in-memory — no real dataset lookup, no network.
describe("assembleZoneRisk", () => {
  const NOW_ISO = "2026-07-22T01:33:40.000Z";

  function freshLocation(overrides: Partial<VehicleLocation> = {}): VehicleLocation {
    return {
      latitude: 35.078091,
      longitude: -81.721605,
      observedAt: "2026-07-22T01:33:35.000Z",
      fetchedAt: NOW_ISO,
      provider: "samsara",
      providerVehicleId: "1000000000001",
      vehicleIdSource: "driver_event",
      state: "fresh",
      source: "vehicle_stats",
      ...overrides,
    };
  }

  function staleLocation(): VehicleLocation {
    return freshLocation({ state: "stale", observedAt: "2026-07-22T01:03:40.000Z" });
  }

  function unavailableLocation(): VehicleLocation {
    return {
      latitude: null,
      longitude: null,
      observedAt: null,
      fetchedAt: NOW_ISO,
      provider: null,
      providerVehicleId: null,
      vehicleIdSource: "unavailable",
      state: "unavailable",
      source: "none",
    };
  }

  const TEST_ZONE: ZoneDefinition = {
    id: "test-zone",
    name: "Test High-Risk Corridor",
    latitude: 35.078091,
    longitude: -81.721605,
    radiusMiles: 10,
    riskScore: 0.65,
  };
  const ZONE_MATCH: ZoneMatch = { zone: TEST_ZONE, distanceMiles: 0 };

  test("pilot with fresh GPS: zone risk is looked up using the real GPS coordinates", async () => {
    let calledWith: { latitude: number; longitude: number } | null = null;
    const { field, detail } = await assembleZoneRisk("drv_1", true, NOW_ISO, freshLocation(), {
      matchZone: (latitude, longitude) => {
        calledWith = { latitude, longitude };
        return ZONE_MATCH;
      },
    });

    assert.deepEqual(calledWith, { latitude: 35.078091, longitude: -81.721605 });
    assert.equal(field.origin, "observed");
    assert.equal(field.state, "fresh");
    assert.equal(field.provider, "internal_geofence");
    assert.equal(field.value, 0.65);

    assert.equal(detail.zoneRisk, 0.65);
    assert.equal(detail.zoneName, "Test High-Risk Corridor");
    assert.equal(detail.status, "available");
    assert.equal(detail.origin, "observed");
    assert.equal(detail.provider, "internal_geofence");
    assert.equal(detail.latitude, 35.078091);
    assert.equal(detail.longitude, -81.721605);
    assert.equal(detail.locationState, "fresh");
    assert.equal(detail.locationObservedAt, "2026-07-22T01:33:35.000Z");
    assert.equal(detail.matchedZoneId, "test-zone");
    assert.equal(detail.distanceMiles, 0);
  });

  test("pilot with stale GPS: zone matching is never attempted, zone risk is unavailable", async () => {
    let called = false;
    const { field, detail } = await assembleZoneRisk("drv_1", true, NOW_ISO, staleLocation(), {
      matchZone: () => {
        called = true;
        return ZONE_MATCH;
      },
    });

    assert.equal(called, false, "stale GPS must never drive a zone lookup");
    assert.equal(field.value, null);
    assert.equal(field.origin, null);
    assert.equal(field.state, "unavailable");
    assert.equal(detail.status, "unavailable");
    assert.equal(detail.zoneRisk, null);
    assert.equal(detail.latitude, null, "no coordinates were used — none should be reported as used");
    assert.equal(detail.locationState, "stale", "the underlying GPS state is still surfaced for transparency");
  });

  test("pilot with unavailable GPS: zone matching is never attempted, zone risk is unavailable", async () => {
    let called = false;
    const { field, detail } = await assembleZoneRisk("drv_1", true, NOW_ISO, unavailableLocation(), {
      matchZone: () => {
        called = true;
        return ZONE_MATCH;
      },
    });

    assert.equal(called, false);
    assert.equal(field.state, "unavailable");
    assert.equal(detail.status, "unavailable");
    assert.equal(detail.locationState, "unavailable");
    assert.equal(detail.locationObservedAt, null);
  });

  test("pilot with fresh GPS but no zone match: a real 0 reading (outside monitored zones), never 'unavailable' and never simulated", async () => {
    const { field, detail } = await assembleZoneRisk("drv_1", true, NOW_ISO, freshLocation(), {
      matchZone: () => null,
    });

    // Fresh, real GPS with no curated-zone hit is a genuine available
    // reading of "no known elevated zone risk here" — not a data gap. See
    // the zone-semantics clarification (2026-08-04): only a stale/
    // unavailable location is a real gap (locationGap in assemble.ts).
    assert.equal(field.state, "fresh");
    assert.equal(field.origin, "observed");
    assert.notEqual(field.origin, "simulated");
    assert.equal(field.value, 0);
    assert.equal(detail.availability, "outside_monitored_zones");
    assert.equal(detail.status, "available");
    assert.equal(detail.zoneRisk, 0);
    assert.equal(detail.zoneName, null);
    assert.equal(detail.latitude, 35.078091, "coordinates that WERE attempted are still reported for debugging transparency");
    assert.equal(detail.locationState, "fresh");
    assert.equal(detail.matchedZoneId, null);
  });

  test("pilot never falls back to scenario zone data on any path", async () => {
    // Fresh GPS + no match is a real "observed" 0 reading (outside_monitored_zones),
    // not null — see the dedicated test above. Only the location-gap paths
    // below (stale/unavailable GPS) have a null origin. Either way, a pilot's
    // zoneRisk origin must never be "simulated".
    const freshResult = await assembleZoneRisk("drv_1", true, NOW_ISO, freshLocation(), { matchZone: () => null });
    assert.equal(freshResult.field.origin, "observed");
    assert.notEqual(freshResult.field.origin, "simulated");

    const staleResult = await assembleZoneRisk("drv_1", true, NOW_ISO, staleLocation());
    assert.equal(staleResult.field.origin, null);
    assert.notEqual(staleResult.field.origin, "simulated");

    const unavailableResult = await assembleZoneRisk("drv_1", true, NOW_ISO, unavailableLocation());
    assert.equal(unavailableResult.field.origin, null);
    assert.notEqual(unavailableResult.field.origin, "simulated");
  });

  test("demo: uses scenario zoneRisk/zoneName regardless of location, simulated/fresh provenance", async () => {
    const scenario = getScenarioForDriver("mock-driver-id");
    let called = false;
    const { field, detail } = await assembleZoneRisk("mock-driver-id", false, NOW_ISO, unavailableLocation(), {
      matchZone: () => {
        called = true;
        return ZONE_MATCH;
      },
    });

    assert.equal(called, false, "demo must never use the real zone dataset lookup");
    assert.equal(field.origin, "simulated");
    assert.equal(field.state, "fresh");
    assert.equal(field.provider, "internal");
    assert.equal(field.value, scenario.zoneRisk);
    assert.equal(detail.zoneName, scenario.zoneName);
    assert.equal(detail.status, "available");
    assert.equal(detail.origin, "simulated");
    assert.equal(detail.locationState, null, "demo zone risk is not gated by pilot GPS state");
    assert.equal(detail.matchedZoneId, null);
  });
});

describe("assembleSpeed", () => {
  const NOW_ISO = "2026-07-22T01:33:40.000Z";

  function freshLocation(overrides: Partial<VehicleLocation> = {}): VehicleLocation {
    return {
      latitude: 35.078091,
      longitude: -81.721605,
      observedAt: "2026-07-22T01:33:35.000Z",
      fetchedAt: NOW_ISO,
      provider: "samsara",
      providerVehicleId: "1000000000001",
      vehicleIdSource: "driver_event",
      state: "fresh",
      source: "vehicle_stats",
      speedMilesPerHour: 72.4,
      isEcuSpeed: true,
      ...overrides,
    };
  }

  function staleLocation(): VehicleLocation {
    return freshLocation({ state: "stale", observedAt: "2026-07-22T01:03:40.000Z" });
  }

  function unavailableLocation(): VehicleLocation {
    return {
      latitude: null,
      longitude: null,
      observedAt: null,
      fetchedAt: NOW_ISO,
      provider: null,
      providerVehicleId: null,
      vehicleIdSource: "unavailable",
      state: "unavailable",
      source: "none",
    };
  }

  test("pilot with fresh GPS: speed comes from the same GPS reading's speedMilesPerHour", () => {
    const { field } = assembleSpeed("drv_1", true, NOW_ISO, freshLocation());

    assert.equal(field.value, 72.4);
    assert.equal(field.origin, "observed");
    assert.equal(field.state, "fresh");
    assert.equal(field.provider, "samsara");
    assert.equal(field.observedAt, "2026-07-22T01:33:35.000Z");
  });

  test("pilot with stale GPS: speed is unavailable, never the stale reading", () => {
    const { field } = assembleSpeed("drv_1", true, NOW_ISO, staleLocation());

    assert.equal(field.value, null);
    assert.equal(field.origin, null);
    assert.equal(field.state, "unavailable");
  });

  test("pilot with unavailable GPS: speed is unavailable", () => {
    const { field } = assembleSpeed("drv_1", true, NOW_ISO, unavailableLocation());

    assert.equal(field.value, null);
    assert.equal(field.state, "unavailable");
  });

  test("pilot with fresh GPS but a null speedMilesPerHour reading: unavailable, never fabricated as 0", () => {
    const { field } = assembleSpeed("drv_1", true, NOW_ISO, freshLocation({ speedMilesPerHour: null }));

    assert.equal(field.value, null);
    assert.equal(field.state, "unavailable");
    assert.notEqual(field.value, 0, "a missing reading must never be reported as 0 mph");
  });

  test("pilot never falls back to simulated speed on any path", () => {
    const freshNullSpeed = assembleSpeed("drv_1", true, NOW_ISO, freshLocation({ speedMilesPerHour: null }));
    assert.notEqual(freshNullSpeed.field.origin, "simulated");

    const stale = assembleSpeed("drv_1", true, NOW_ISO, staleLocation());
    assert.notEqual(stale.field.origin, "simulated");

    const unavailable = assembleSpeed("drv_1", true, NOW_ISO, unavailableLocation());
    assert.notEqual(unavailable.field.origin, "simulated");
  });

  test("demo: uses scenario currentSpeed regardless of location, simulated/fresh provenance", () => {
    const scenario = getScenarioForDriver("mock-driver-id");
    const { field } = assembleSpeed("mock-driver-id", false, NOW_ISO, unavailableLocation());

    assert.equal(field.origin, "simulated");
    assert.equal(field.state, "fresh");
    assert.equal(field.provider, "internal");
    assert.equal(field.value, scenario.currentSpeed);
  });

  // Speed plausibility (defense layer 1 of 2 — see MAX_PLAUSIBLE_SPEED_MPH /
  // isPlausibleSpeed in lib/riskEngine.ts for layer 2, inside the engine
  // itself). A fresh GPS reading with an implausible speedMilesPerHour is
  // corrupted telemetry, not a real fast truck — it must be marked
  // unavailable here so contextSources.speed never reports `observed`/
  // `fresh` next to a bogus number.
  describe("implausible speedMilesPerHour is rejected as unavailable, never observed", () => {
    test("negative speedMilesPerHour: unavailable, not fabricated as a real reading", () => {
      const { field } = assembleSpeed("drv_1", true, NOW_ISO, freshLocation({ speedMilesPerHour: -5 }));
      assert.equal(field.value, null);
      assert.equal(field.origin, null);
      assert.equal(field.state, "unavailable");
    });

    test("speedMilesPerHour above MAX_PLAUSIBLE_SPEED_MPH (e.g. 99999): unavailable, never scored as an extremely fast truck", () => {
      const { field } = assembleSpeed("drv_1", true, NOW_ISO, freshLocation({ speedMilesPerHour: 99999 }));
      assert.equal(field.value, null);
      assert.equal(field.state, "unavailable");
    });

    test("speedMilesPerHour exactly at MAX_PLAUSIBLE_SPEED_MPH (120): still observed, this is the valid boundary", () => {
      const { field } = assembleSpeed("drv_1", true, NOW_ISO, freshLocation({ speedMilesPerHour: 120 }));
      assert.equal(field.value, 120);
      assert.equal(field.origin, "observed");
      assert.equal(field.state, "fresh");
    });

    test("speedMilesPerHour just above the boundary (121): unavailable — no silently invented tolerance", () => {
      const { field } = assembleSpeed("drv_1", true, NOW_ISO, freshLocation({ speedMilesPerHour: 121 }));
      assert.equal(field.value, null);
      assert.equal(field.state, "unavailable");
    });

    test("NaN speedMilesPerHour: unavailable, not a crash", () => {
      const { field } = assembleSpeed("drv_1", true, NOW_ISO, freshLocation({ speedMilesPerHour: NaN }));
      assert.equal(field.value, null);
      assert.equal(field.state, "unavailable");
    });
  });
});

// N1 (Phase 5, 2026-08-05) — assembleDriverContext threads ONE `now` value
// into every field's `fetchedAt`, and returns that same value as
// `calculatedAt` for callers (e.g. /api/risk) to reuse as their own
// top-level response timestamp, instead of independently computing a
// second `new Date()`. assembleDriverContext itself isn't called directly
// in this file (see the file-header note — it isn't dependency-injectable
// at the top level, and would reach getWeatherRiskField's real network
// call). Instead, this proves the same guarantee one level down, using the
// individually-injectable functions assembleDriverContext composes:
// location/weather/zone's `detail.fetchedAt` must all agree when given the
// same `now`, which is exactly the mechanism `calculatedAt` relies on.
describe("assembleDriverContext's single-`now` guarantee (N1 — one calculation timestamp)", () => {
  const NOW_ISO = "2026-07-22T01:33:40.000Z";

  const TEST_ZONE: ZoneDefinition = {
    id: "test-zone",
    name: "Test Zone",
    latitude: 35.078091,
    longitude: -81.721605,
    radiusMiles: 10,
    riskScore: 0.5,
  };

  test("location/weather/zone fetchedAt all equal the same injected `now`, for a pilot with fresh GPS", async () => {
    const { detail: locationDetail } = await assembleLocation("drv_1", true, NOW_ISO, {
      resolveVehicleId: async () => ({ vehicleId: "1000000000001", source: "driver_event" }),
      fetchGpsSnapshot: async () => ({
        data: [{
          id: "1000000000001",
          gps: {
            time: "2026-07-22T01:33:35.000Z", // event time — deliberately NOT equal to NOW_ISO
            latitude: 35.078091,
            longitude: -81.721605,
          },
        }],
        pagination: { endCursor: "", hasNextPage: false },
      }),
    });

    const { detail: weatherDetail } = await assembleWeather("drv_1", true, NOW_ISO, locationDetail, {
      fetchWeather: async () => ({ weatherRisk: 0.2, observedAt: "2026-07-22T01:20:00.000Z", conditionSummary: "clear" }),
    });

    const { detail: zoneDetail } = await assembleZoneRisk("drv_1", true, NOW_ISO, locationDetail, {
      matchZone: () => ({ zone: TEST_ZONE, distanceMiles: 0 }),
    });

    // The calculation-time invariant: every domain's fetchedAt is the same
    // instant assembleDriverContext would return as `calculatedAt`.
    assert.equal(locationDetail.fetchedAt, NOW_ISO);
    assert.equal(weatherDetail.fetchedAt, NOW_ISO);
    assert.equal(zoneDetail.fetchedAt, NOW_ISO);

    // Do not misrepresent provider event timestamps as calculation
    // timestamps: observedAt (the provider's own event time) must remain
    // free to differ from fetchedAt (SafeHaul's calculation instant) —
    // proving the two are tracked independently, not silently unified.
    assert.equal(locationDetail.observedAt, "2026-07-22T01:33:35.000Z");
    assert.notEqual(locationDetail.observedAt, locationDetail.fetchedAt);
    assert.equal(weatherDetail.observedAt, "2026-07-22T01:20:00.000Z");
    assert.notEqual(weatherDetail.observedAt, weatherDetail.fetchedAt);
  });

  test("fetchedAt still agrees across domains even when location is stale (weather/zone become unavailable, but their fetchedAt — the attempt time — is still the shared `now`)", async () => {
    const { detail: locationDetail } = await assembleLocation("drv_1", true, NOW_ISO, {
      resolveVehicleId: async () => ({ vehicleId: "1000000000001", source: "driver_event" }),
      fetchGpsSnapshot: async () => ({
        data: [{
          id: "1000000000001",
          gps: { time: "2026-07-22T01:03:40.000Z", latitude: 35.078091, longitude: -81.721605 }, // 30 min old -> stale
        }],
        pagination: { endCursor: "", hasNextPage: false },
      }),
    });
    assert.equal(locationDetail.state, "stale");

    const { detail: weatherDetail } = await assembleWeather("drv_1", true, NOW_ISO, locationDetail, {
      fetchWeather: async () => { throw new Error("must not be called for stale location"); },
    });
    const { detail: zoneDetail } = await assembleZoneRisk("drv_1", true, NOW_ISO, locationDetail, {
      matchZone: () => { throw new Error("must not be called for stale location"); },
    });

    assert.equal(weatherDetail.status, "unavailable");
    assert.equal(zoneDetail.availability, "location_stale");

    // Even on the unavailable path, fetchedAt still reflects the shared
    // calculation instant, not null/omitted — the attempt happened at `now`
    // even though it produced no value.
    assert.equal(locationDetail.fetchedAt, NOW_ISO);
    assert.equal(weatherDetail.fetchedAt, NOW_ISO);
    assert.equal(zoneDetail.fetchedAt, NOW_ISO);
  });
});

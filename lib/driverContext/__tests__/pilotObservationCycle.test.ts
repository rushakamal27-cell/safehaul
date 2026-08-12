/**
 * Targeted tests for the Phase 6B.6 combined hybrid pilot observation cycle
 * (lib/driverContext/pilotObservationCycle.ts). All DB/provider dependencies
 * are faked in-memory — no real database or network call is made.
 *
 * "unauthorized route rejected" (Requirement 11) is deliberately NOT
 * re-tested here — app/api/sync/pilot-observation-cycle/route.ts reuses
 * lib/cronAuth.ts::verifyCronSecret verbatim, which already has its own
 * dedicated unit tests in lib/__tests__/cronAuth.test.ts. Route files
 * themselves are outside this project's test glob (see CLAUDE.md), so
 * that auth check is (and always has been, since Phase 6B.3) validated at
 * the shared-helper level plus manual/live curl calls, not per-route.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runPilotObservationCycle, type PilotObservationCycleDeps } from "../pilotObservationCycle";
import type { ProviderSyncStateClient } from "@/lib/providerSyncLock";
import type { SamsaraSyncOutcome } from "@/lib/providers/samsara/syncSafetyEvents";
import type { PilotDriverIdClient, RecentObservationClient } from "../baselineObservationSync";
import type { CaptureDriverObservationDeps } from "../captureObservation";
import type { VehicleLocation, WeatherDetail, HosDetail, ZoneDetail, DriverContext } from "../types";

const NOW = new Date("2026-08-12T15:00:00.000Z");
const NOW_ISO = NOW.toISOString();

// ---------------------------------------------------------------------------
// Shared fake ProviderSyncState store — used for BOTH the job lock
// (samsara/pilot-observation-cycle) and the Safety Events lock
// (samsara/safety-events), exactly like the real table holds both rows.
// ---------------------------------------------------------------------------

interface FakeRow {
  provider: string;
  streamKey: string;
  syncLockedAt: Date | null;
}

function makeSharedLockStore(initialRows: FakeRow[] = []) {
  const rows = new Map<string, FakeRow>(initialRows.map((r) => [`${r.provider}::${r.streamKey}`, r]));

  const client: ProviderSyncStateClient = {
    async findUnique({ where }) {
      const row = rows.get(`${where.provider_streamKey.provider}::${where.provider_streamKey.streamKey}`);
      return row ? { lastSyncAt: null } : null;
    },
    async create({ data }) {
      const key = `${data.provider}::${data.streamKey}`;
      if (rows.has(key)) {
        const err = new Error("Unique constraint failed") as Error & { code: string };
        err.code = "P2002";
        throw err;
      }
      rows.set(key, { provider: data.provider, streamKey: data.streamKey, syncLockedAt: data.syncLockedAt });
    },
    async updateMany({ where, data }) {
      const key = `${where.provider}::${where.streamKey}`;
      const row = rows.get(key);
      if (!row) return { count: 0 };
      const staleBefore = where.OR[1].syncLockedAt.lt;
      const claimable = row.syncLockedAt === null || row.syncLockedAt < staleBefore;
      if (!claimable) return { count: 0 };
      row.syncLockedAt = data.syncLockedAt;
      return { count: 1 };
    },
    async update({ where, data }) {
      const row = rows.get(`${where.provider_streamKey.provider}::${where.provider_streamKey.streamKey}`);
      if (row) row.syncLockedAt = data.syncLockedAt;
    },
  };

  return { client, getRow: (provider: string, streamKey: string) => rows.get(`${provider}::${streamKey}`) };
}

function emptyEnrichment() {
  return { eventsCreated: 0, enrichmentAttempted: 0, enrichmentCreated: 0, enrichmentSkipped: 0, enrichmentFailed: 0 };
}

function successSyncOutcome(driverEventsCreated = 0): SamsaraSyncOutcome {
  return {
    synced: true,
    skipped: false,
    cursor: "cursor-1",
    elapsedMs: 5,
    pagesProcessed: 1,
    eventsProcessed: 0,
    eventsSkipped: 0,
    skipReasons: { no_driver_id: 0, unsupported_behavior_label: 0, no_timestamp: 0, unexpected_error: 0 },
    unsupportedLabelsFound: {},
    duplicates: 0,
    driverEventsCreated,
    newDriverEventIds: driverEventsCreated > 0 ? ["de_1"] : [],
    enrichment: driverEventsCreated > 0
      ? { eventsCreated: 1, enrichmentAttempted: 1, enrichmentCreated: 1, enrichmentSkipped: 0, enrichmentFailed: 0 }
      : emptyEnrichment(),
  };
}

// ---------------------------------------------------------------------------
// Baseline fakes — mirrors lib/driverContext/__tests__/baselineObservationSync.test.ts
// ---------------------------------------------------------------------------

function fakeLocationDetail(overrides: Partial<VehicleLocation> = {}): VehicleLocation {
  return {
    latitude: 40.3, longitude: -74.5, observedAt: NOW_ISO, fetchedAt: NOW_ISO,
    provider: "samsara", providerVehicleId: "veh-1", vehicleIdSource: "provider_mapping",
    state: "fresh", source: "vehicle_stats",
    ...overrides,
  };
}
function fakeWeatherDetail(overrides: Partial<WeatherDetail> = {}): WeatherDetail {
  return {
    weatherRisk: 2, status: "available", origin: "observed", provider: "openweather",
    observedAt: NOW_ISO, fetchedAt: NOW_ISO, latitude: 40.3, longitude: -74.5,
    locationState: "fresh", locationObservedAt: NOW_ISO, conditionSummary: "clear sky",
    ...overrides,
  };
}
function fakeHosDetail(overrides: Partial<HosDetail> = {}): HosDetail {
  return {
    drivingHoursUsed: null, drivingHoursRemaining: 8, shiftHoursUsed: 3.5,
    status: "available", source: "samsara", updatedAt: NOW_ISO,
    ...overrides,
  };
}
function fakeZoneDetail(overrides: Partial<ZoneDetail> = {}): ZoneDetail {
  return {
    zoneRisk: 0, zoneName: null, zoneType: null, zoneExplanation: null,
    availability: "outside_monitored_zones", explanation: "Outside monitored risk zones",
    status: "available", origin: "observed", provider: "internal_geofence",
    observedAt: NOW_ISO, fetchedAt: NOW_ISO, latitude: 40.3, longitude: -74.5,
    locationState: "fresh", locationObservedAt: NOW_ISO, matchedZoneId: null, distanceMiles: null,
    ...overrides,
  };
}

interface BaselineHarnessOptions {
  pilotDriverIds: string[];
  recentObservations?: Record<string, Date>;
  locationOverrides?: Record<string, Partial<VehicleLocation>>;
  pilotDriverIdClientThrows?: boolean;
  createCalls?: unknown[];
}

function makeBaselineDeps(opts: BaselineHarnessOptions) {
  const createCalls = opts.createCalls ?? [];

  const pilotDriverIdClient: PilotDriverIdClient = {
    async findMany() {
      if (opts.pilotDriverIdClientThrows) throw new Error("connection lost");
      return opts.pilotDriverIds.map((driverId) => ({ driverId }));
    },
  };
  const recentObservationClient: RecentObservationClient = {
    async findFirst({ where }) {
      const observedAt = opts.recentObservations?.[where.driverId];
      return observedAt ? { observedAt } : null;
    },
  };

  const captureDeps: CaptureDriverObservationDeps = {
    driverClient: { async findUnique() { return { id: "irrelevant" }; } },
    driverEventClient: { async findUnique() { return null; } },
    observationClient: {
      async create(args) {
        createCalls.push(args.data);
        return { id: `obs-${createCalls.length}` };
      },
    },
    isPilotDriver: async () => true,
    assembleLocationFn: async (driverId) => ({
      field: { value: { latitude: 40.3, longitude: -74.5 }, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["location"],
      detail: fakeLocationDetail(opts.locationOverrides?.[driverId]),
    }),
    assembleWeatherFn: async () => ({ field: { value: 2, origin: "observed", state: "fresh", provider: "openweather", observedAt: NOW_ISO } as DriverContext["weather"], detail: fakeWeatherDetail() }),
    assembleZoneRiskFn: async () => ({ field: { value: 0, origin: "observed", state: "fresh", provider: "internal_geofence", observedAt: NOW_ISO } as DriverContext["zoneRisk"], detail: fakeZoneDetail() }),
    assembleHosFn: async () => ({ field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null } as DriverContext["hos"], detail: fakeHosDetail({ shiftHoursUsed: null, status: "unavailable", source: "none", updatedAt: null }) }),
    assembleSpeedFn: () => ({ field: { value: 55, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["speed"] }),
    now: () => NOW,
  };

  return { pilotDriverIdClient, recentObservationClient, isPilotDriver: async () => true, now: () => NOW, captureDeps };
}

describe("runPilotObservationCycle — combined ordering", () => {
  test("Safety Events runs before baseline", async () => {
    const callOrder: string[] = [];
    const lockStore = makeSharedLockStore();
    const baselineDeps = makeBaselineDeps({ pilotDriverIds: ["driver-1"] });

    const deps: PilotObservationCycleDeps = {
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: {
        client: lockStore.client,
        runSync: async () => {
          callOrder.push("safety-events");
          return successSyncOutcome(0);
        },
      },
      baselineDeps: {
        ...baselineDeps,
        captureDeps: {
          ...baselineDeps.captureDeps,
          assembleLocationFn: async (driverId) => {
            callOrder.push("baseline");
            return {
              field: { value: { latitude: 40.3, longitude: -74.5 }, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["location"],
              detail: fakeLocationDetail(),
            };
          },
        },
      },
    };

    const result = await runPilotObservationCycle(deps);

    assert.equal(result.ok, true);
    if (result.ok && result.cycleStatus === "completed") {
      assert.equal(result.safetyEvents.status, "synced");
      assert.equal(result.baseline.status, "completed");
    }
    assert.deepEqual(callOrder, ["safety-events", "baseline"]);
  });
});

describe("runPilotObservationCycle — Safety Events lock respected, baseline still proceeds", () => {
  test("Safety Events lock already held elsewhere: reports sync_in_progress, baseline still runs", async () => {
    const lockStore = makeSharedLockStore([
      { provider: "samsara", streamKey: "safety-events", syncLockedAt: new Date() }, // held by someone else
    ]);
    const baselineDeps = makeBaselineDeps({ pilotDriverIds: ["driver-1"] });
    let safetyRunCalls = 0;

    const result = await runPilotObservationCycle({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: {
        client: lockStore.client,
        runSync: async () => {
          safetyRunCalls++;
          return successSyncOutcome(0);
        },
      },
      baselineDeps,
    });

    assert.equal(safetyRunCalls, 0, "Safety Events must never drain while another caller holds the lock");
    if (result.ok && result.cycleStatus === "completed") {
      assert.equal(result.safetyEvents.status, "sync_in_progress");
      assert.equal(result.baseline.status, "completed");
      if (result.baseline.status === "completed") {
        assert.equal(result.baseline.created, 1, "baseline must still create a due observation even though Safety Events was busy");
      }
    } else {
      assert.fail(`expected a completed cycle, got ${JSON.stringify(result)}`);
    }
  });

  test("Safety Events sync fails: baseline still runs and succeeds", async () => {
    const lockStore = makeSharedLockStore();
    const baselineDeps = makeBaselineDeps({ pilotDriverIds: ["driver-1"] });

    const result = await runPilotObservationCycle({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: {
        client: lockStore.client,
        runSync: async () => {
          throw new Error("Samsara returned 500");
        },
      },
      baselineDeps,
    });

    if (result.ok && result.cycleStatus === "completed") {
      assert.equal(result.safetyEvents.status, "failed");
      assert.equal(result.baseline.status, "completed");
      if (result.baseline.status === "completed") assert.equal(result.baseline.created, 1);
    } else {
      assert.fail(`expected a completed cycle, got ${JSON.stringify(result)}`);
    }
  });
});

describe("runPilotObservationCycle — baseline failure isolation", () => {
  test("baseline's own DB failure does NOT retroactively fail an already-successful Safety Events result", async () => {
    const lockStore = makeSharedLockStore();
    const baselineDeps = makeBaselineDeps({ pilotDriverIds: [], pilotDriverIdClientThrows: true });

    const result = await runPilotObservationCycle({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: {
        client: lockStore.client,
        runSync: async () => successSyncOutcome(1),
      },
      baselineDeps,
    });

    if (result.ok && result.cycleStatus === "completed") {
      assert.equal(result.safetyEvents.status, "synced");
      if (result.safetyEvents.status === "synced") assert.equal(result.safetyEvents.driverEventsCreated, 1);
      assert.equal(result.baseline.status, "failed");
    } else {
      assert.fail(`expected a completed cycle, got ${JSON.stringify(result)}`);
    }
  });
});

describe("runPilotObservationCycle — job-level concurrency", () => {
  test("two simultaneous cycle invocations: exactly one performs the work, the other reports cycle_in_progress", async () => {
    const lockStore = makeSharedLockStore();
    let safetyRunCalls = 0;
    let baselineBuildCalls = 0;

    const makeDeps = (): PilotObservationCycleDeps => ({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: {
        client: lockStore.client,
        runSync: async () => {
          safetyRunCalls++;
          await new Promise((r) => setTimeout(r, 5));
          return successSyncOutcome(0);
        },
      },
      baselineDeps: {
        ...makeBaselineDeps({ pilotDriverIds: ["driver-1"] }),
        captureDeps: {
          ...makeBaselineDeps({ pilotDriverIds: ["driver-1"] }).captureDeps,
          assembleLocationFn: async () => {
            baselineBuildCalls++;
            return {
              field: { value: { latitude: 40.3, longitude: -74.5 }, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["location"],
              detail: fakeLocationDetail(),
            };
          },
        },
      },
    });

    const [a, b] = await Promise.all([
      runPilotObservationCycle(makeDeps()),
      runPilotObservationCycle(makeDeps()),
    ]);

    const cycleStatuses = [a.cycleStatus, b.cycleStatus].sort();
    assert.deepEqual(cycleStatuses, ["completed", "cycle_in_progress"]);
    assert.equal(safetyRunCalls, 1, "only the job-lock winner may run Safety Events");
    assert.equal(baselineBuildCalls, 1, "only the job-lock winner may run baseline collection");
  });

  test("job lock is released after a completed cycle, even when a sub-step fails", async () => {
    const lockStore = makeSharedLockStore();

    await runPilotObservationCycle({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: {
        client: lockStore.client,
        runSync: async () => { throw new Error("Samsara down"); },
      },
      baselineDeps: makeBaselineDeps({ pilotDriverIds: [], pilotDriverIdClientThrows: true }),
    });

    assert.equal(
      lockStore.getRow("samsara", "pilot-observation-cycle")?.syncLockedAt,
      null,
      "job lock must be released even when both sub-steps failed"
    );
  });

  test("a stale job lock (older than 20s) is reclaimable", async () => {
    const staleLock = new Date(Date.now() - 30_000);
    const lockStore = makeSharedLockStore([
      { provider: "samsara", streamKey: "pilot-observation-cycle", syncLockedAt: staleLock },
    ]);
    const baselineDeps = makeBaselineDeps({ pilotDriverIds: ["driver-1"] });

    const result = await runPilotObservationCycle({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: { client: lockStore.client, runSync: async () => successSyncOutcome(0) },
      baselineDeps,
    });

    assert.equal(result.cycleStatus, "completed");
    assert.equal(lockStore.getRow("samsara", "pilot-observation-cycle")?.syncLockedAt, null);
  });
});

describe("runPilotObservationCycle — repeated invocation does not duplicate baseline rows", () => {
  test("an immediate second cycle skips baseline as recent_observation, no duplicate row created", async () => {
    const lockStore = makeSharedLockStore();
    const createCalls: unknown[] = [];
    let storedObservedAt: Date | null = null;

    const pilotDriverIdClient: PilotDriverIdClient = { async findMany() { return [{ driverId: "driver-1" }]; } };
    const recentObservationClient: RecentObservationClient = {
      async findFirst() {
        return storedObservedAt ? { observedAt: storedObservedAt } : null;
      },
    };
    const captureDeps: CaptureDriverObservationDeps = {
      driverClient: { async findUnique() { return { id: "irrelevant" }; } },
      driverEventClient: { async findUnique() { return null; } },
      observationClient: {
        async create(args) {
          storedObservedAt = args.data.observedAt as Date;
          createCalls.push(args.data);
          return { id: `obs-${createCalls.length}` };
        },
      },
      isPilotDriver: async () => true,
      assembleLocationFn: async () => ({
        field: { value: { latitude: 40.3, longitude: -74.5 }, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["location"],
        detail: fakeLocationDetail(),
      }),
      assembleWeatherFn: async () => ({ field: { value: 2, origin: "observed", state: "fresh", provider: "openweather", observedAt: NOW_ISO } as DriverContext["weather"], detail: fakeWeatherDetail() }),
      assembleZoneRiskFn: async () => ({ field: { value: 0, origin: "observed", state: "fresh", provider: "internal_geofence", observedAt: NOW_ISO } as DriverContext["zoneRisk"], detail: fakeZoneDetail() }),
      assembleHosFn: async () => ({ field: { value: 3.5, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["hos"], detail: fakeHosDetail() }),
      assembleSpeedFn: () => ({ field: { value: 55, origin: "observed", state: "fresh", provider: "samsara", observedAt: NOW_ISO } as DriverContext["speed"] }),
    };

    const makeSafetyDeps = () => ({ client: lockStore.client, runSync: async () => successSyncOutcome(0) });

    const first = await runPilotObservationCycle({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: makeSafetyDeps(),
      baselineDeps: { pilotDriverIdClient, recentObservationClient, isPilotDriver: async () => true, now: () => NOW, captureDeps: { ...captureDeps, now: () => NOW } },
    });

    const second = await runPilotObservationCycle({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: makeSafetyDeps(),
      baselineDeps: {
        pilotDriverIdClient,
        recentObservationClient,
        isPilotDriver: async () => true,
        now: () => new Date(NOW.getTime() + 3 * 60 * 1000), // 3 minutes later — well inside the 10-minute guard
        captureDeps: { ...captureDeps, now: () => new Date(NOW.getTime() + 3 * 60 * 1000) },
      },
    });

    assert.equal(createCalls.length, 1, "only the first cycle should have created a baseline row");
    if (first.ok && first.cycleStatus === "completed" && first.baseline.status === "completed") {
      assert.equal(first.baseline.created, 1);
    }
    if (second.ok && second.cycleStatus === "completed" && second.baseline.status === "completed") {
      assert.equal(second.baseline.created, 0);
      assert.equal(second.baseline.skipped, 1);
    }
  });
});

describe("runPilotObservationCycle — Safety Events result mapping (enrichment pass-through)", () => {
  test("a successful sync with new events reports enrichment stats unchanged", async () => {
    const lockStore = makeSharedLockStore();
    const baselineDeps = makeBaselineDeps({ pilotDriverIds: [] });

    const result = await runPilotObservationCycle({
      jobLockClient: lockStore.client,
      safetyEventsLockDeps: { client: lockStore.client, runSync: async () => successSyncOutcome(1) },
      baselineDeps,
    });

    if (result.ok && result.cycleStatus === "completed" && result.safetyEvents.status === "synced") {
      assert.equal(result.safetyEvents.driverEventsCreated, 1);
      assert.deepEqual(result.safetyEvents.newDriverEventIds, ["de_1"]);
      assert.equal(result.safetyEvents.enrichmentCreated, 1);
      assert.equal(result.safetyEvents.enrichmentAttempted, 1);
      assert.equal(result.safetyEvents.enrichmentSkipped, 0);
      assert.equal(result.safetyEvents.enrichmentFailed, 0);
    } else {
      assert.fail(`expected a synced safetyEvents result, got ${JSON.stringify(result)}`);
    }
  });
});

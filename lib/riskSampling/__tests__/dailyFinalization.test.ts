/**
 * Targeted tests for lib/riskSampling/dailyFinalization.ts. All DB/provider
 * dependencies are faked in-memory — no real database or network call is
 * made, same convention as
 * lib/driverContext/__tests__/baselineObservationSync.test.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runDailyFinalization,
  type DailyFinalizationDeps,
  type PilotDriverIdClient,
  type SafetyScoreSampleAggClient,
  type DailySafetyScoreClient,
  type DriverObservationAggClient,
  type DailyDrivingSummaryClient,
} from "../dailyFinalization";
import { Prisma } from "@/lib/generated/prisma";

function makeP2002(): Error {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

// Run "now" just after UTC midnight — finalizes 2026-08-22 (the previous day).
const NOW = new Date("2026-08-23T00:10:00.000Z");
const DAY = new Date("2026-08-22T00:00:00.000Z");

function makeScoreStore(driverId: string, scores: number[]) {
  return { [driverId]: scores };
}

interface HarnessOptions {
  pilotDriverIds: string[];
  scoresByDriver?: Record<string, number[]>;
  observationsByDriver?: Record<string, Array<{
    observedAt: Date; latitude: number | null; longitude: number | null;
    speedMph: number | null; weatherRisk: number | null; zoneRisk: number | null;
    formattedLocation?: string | null;
  }>>;
  vehicleIdByDriver?: Record<string, string | null>;
}

function makeHarness(opts: HarnessOptions) {
  const dailyScoreStore = new Map<string, { id: string }>();
  const drivingSummaryStore = new Map<string, { id: string; data: unknown }>();
  const dailyScoreCreateCalls: unknown[] = [];
  const drivingSummaryCreateCalls: unknown[] = [];

  const pilotDriverIdClient: PilotDriverIdClient = {
    async findMany() { return opts.pilotDriverIds.map((driverId) => ({ driverId })); },
  };

  const scoreSampleClient: SafetyScoreSampleAggClient = {
    async findMany({ where }) {
      const scores = opts.scoresByDriver?.[where.driverId] ?? [];
      return scores.map((score) => ({ score }));
    },
  };

  const dailyScoreClient: DailySafetyScoreClient = {
    async findUnique({ where }) {
      const key = `${where.driverId_date.driverId}|${where.driverId_date.date.toISOString()}`;
      return dailyScoreStore.get(key) ?? null;
    },
    async create(args) {
      const key = `${args.data.driverId}|${(args.data.date as Date).toISOString()}`;
      if (dailyScoreStore.has(key)) throw makeP2002();
      dailyScoreCreateCalls.push(args.data);
      const row = { id: `dss-${dailyScoreCreateCalls.length}` };
      dailyScoreStore.set(key, row);
      return row;
    },
  };

  const observationClient: DriverObservationAggClient = {
    async findMany({ where }) {
      const rows = opts.observationsByDriver?.[where.driverId] ?? [];
      return rows.map((r) => ({
        observedAt: r.observedAt,
        latitude: r.latitude,
        longitude: r.longitude,
        speedMph: r.speedMph,
        weatherRisk: r.weatherRisk,
        zoneRisk: r.zoneRisk,
        contextJson: { location: { formattedLocation: r.formattedLocation ?? null } },
      }));
    },
  };

  const drivingSummaryClient: DailyDrivingSummaryClient = {
    async findUnique({ where }) {
      const key = `${where.driverId_date.driverId}|${where.driverId_date.date.toISOString()}`;
      const existing = drivingSummaryStore.get(key);
      return existing ? { id: existing.id } : null;
    },
    async create(args) {
      const key = `${args.data.driverId}|${(args.data.date as Date).toISOString()}`;
      if (drivingSummaryStore.has(key)) throw makeP2002();
      drivingSummaryCreateCalls.push(args.data);
      const row = { id: `dds-${drivingSummaryCreateCalls.length}`, data: args.data };
      drivingSummaryStore.set(key, row);
      return { id: row.id };
    },
  };

  const deps: DailyFinalizationDeps = {
    pilotDriverIdClient,
    scoreSampleClient,
    dailyScoreClient,
    observationClient,
    drivingSummaryClient,
    now: () => NOW,
    resolveVehicleId: async (driverId: string) => ({
      vehicleId: opts.vehicleIdByDriver && driverId in opts.vehicleIdByDriver ? opts.vehicleIdByDriver[driverId] : "veh-1",
      source: "provider_mapping" as const,
    }),
    // No test in this file exercises a successful mileage fetch — always
    // returns too few readings for odometerDeltaMiles to resolve a delta,
    // which is exactly the "mileage unavailable" case most of these tests
    // want. The dedicated "vehicle cannot be resolved" test below never
    // reaches this fake at all (resolveVehicleId short-circuits first).
    fetchOdometerReadings: async () => [],
  };

  return { deps, dailyScoreCreateCalls, drivingSummaryCreateCalls };
}

describe("runDailyFinalization — daily average denominator", () => {
  test("24 valid hourly samples divides by 24", async () => {
    const { deps, dailyScoreCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", Array.from({ length: 24 }, () => 90)),
    });
    const result = await runDailyFinalization(deps);
    assert.equal(result.results[0].safetyScore.status, "created");
    const written = dailyScoreCreateCalls[0] as any;
    assert.equal(written.sampleCount, 24);
    assert.equal(written.averageScore, 90);
    assert.equal(written.expectedSampleCount, 24);
  });

  test("21 valid hourly samples divides by 21, NOT 24", async () => {
    const { deps, dailyScoreCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", Array.from({ length: 21 }, () => 84)),
    });
    await runDailyFinalization(deps);
    const written = dailyScoreCreateCalls[0] as any;
    assert.equal(written.sampleCount, 21);
    assert.equal(written.averageScore, 84);
  });

  test("worked example 100, 80, 60 -> 80", async () => {
    const { deps, dailyScoreCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", [100, 80, 60]),
    });
    await runDailyFinalization(deps);
    assert.equal((dailyScoreCreateCalls[0] as any).averageScore, 80);
  });

  test("no zero fabrication: zero valid samples produces no DailySafetyScore row at all", async () => {
    const { deps, dailyScoreCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", []),
    });
    const result = await runDailyFinalization(deps);
    assert.equal(result.results[0].safetyScore.status, "skipped");
    assert.deepEqual(result.results[0].safetyScore, { status: "skipped", reason: "no_samples" });
    assert.equal(dailyScoreCreateCalls.length, 0);
  });
});

describe("runDailyFinalization — finalization idempotency", () => {
  test("running finalization twice creates exactly one DailySafetyScore and one DailyDrivingSummary", async () => {
    const { deps, dailyScoreCreateCalls, drivingSummaryCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", [90, 80]),
      observationsByDriver: {
        "driver-1": [
          { observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: 55, weatherRisk: 0.1, zoneRisk: 0, formattedLocation: "Baltimore, MD" },
          { observedAt: new Date("2026-08-22T18:00:00Z"), latitude: 41, longitude: -87, speedMph: 55, weatherRisk: 0.2, zoneRisk: 0.1, formattedLocation: "LaPorte County, IN" },
        ],
      },
    });

    const first = await runDailyFinalization(deps);
    assert.equal(first.results[0].safetyScore.status, "created");
    assert.equal(first.results[0].drivingSummary.status, "created");

    const second = await runDailyFinalization(deps);
    assert.equal(second.results[0].safetyScore.status, "skipped");
    assert.deepEqual(second.results[0].safetyScore, { status: "skipped", reason: "already_finalized" });
    assert.equal(second.results[0].drivingSummary.status, "skipped");
    assert.deepEqual(second.results[0].drivingSummary, { status: "skipped", reason: "already_finalized" });

    assert.equal(dailyScoreCreateCalls.length, 1);
    assert.equal(drivingSummaryCreateCalls.length, 1);
  });
});

describe("runDailyFinalization — route span", () => {
  test("earliest/latest moving observation becomes the driving summary's start/end", async () => {
    const { deps, drivingSummaryCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", [90]),
      observationsByDriver: {
        "driver-1": [
          { observedAt: new Date("2026-08-22T18:00:00Z"), latitude: 41, longitude: -87, speedMph: 55, weatherRisk: null, zoneRisk: null, formattedLocation: "LaPorte County, IN" },
          { observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: 55, weatherRisk: null, zoneRisk: null, formattedLocation: "Baltimore, MD" },
        ],
      },
    });
    await runDailyFinalization(deps);
    const written = drivingSummaryCreateCalls[0] as any;
    assert.equal(written.routeSpanAvailable, true);
    assert.equal(written.startLocationLabel, "Baltimore, MD");
    assert.equal(written.endLocationLabel, "LaPorte County, IN");
  });

  test("no-movement day: DailyDrivingSummary still gets created but with routeSpanAvailable false", async () => {
    const { deps, drivingSummaryCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", [90]),
      observationsByDriver: {
        "driver-1": [
          { observedAt: new Date("2026-08-22T06:00:00Z"), latitude: null, longitude: null, speedMph: null, weatherRisk: 0.1, zoneRisk: 0, formattedLocation: null },
        ],
      },
    });
    await runDailyFinalization(deps);
    const written = drivingSummaryCreateCalls[0] as any;
    assert.equal(written.routeSpanAvailable, false);
    assert.equal(written.startLatitude, null);
    assert.equal(written.endLatitude, null);
  });

  test("zero observations that day: no DailyDrivingSummary row at all", async () => {
    const { deps, drivingSummaryCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", [90]),
      observationsByDriver: { "driver-1": [] },
    });
    const result = await runDailyFinalization(deps);
    assert.deepEqual(result.results[0].drivingSummary, { status: "skipped", reason: "no_observations" });
    assert.equal(drivingSummaryCreateCalls.length, 0);
  });
});

describe("runDailyFinalization — mileage unavailable", () => {
  test("when the vehicle cannot be resolved, milesDriven is persisted as null, never 0", async () => {
    const { deps, drivingSummaryCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", [90]),
      observationsByDriver: {
        "driver-1": [
          { observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: 55, weatherRisk: null, zoneRisk: null, formattedLocation: "Baltimore, MD" },
        ],
      },
      vehicleIdByDriver: { "driver-1": null },
    });
    await runDailyFinalization(deps);
    const written = drivingSummaryCreateCalls[0] as any;
    assert.equal(written.milesDriven, null);
  });
});

describe("runDailyFinalization — weather/zone daily averages", () => {
  test("averages only the valid (non-null) readings, omits when none exist", async () => {
    const { deps, drivingSummaryCreateCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      scoresByDriver: makeScoreStore("driver-1", [90]),
      observationsByDriver: {
        "driver-1": [
          { observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: 55, weatherRisk: 0.2, zoneRisk: null, formattedLocation: "A" },
          { observedAt: new Date("2026-08-22T12:00:00Z"), latitude: 40, longitude: -77, speedMph: 55, weatherRisk: 0.4, zoneRisk: null, formattedLocation: "B" },
        ],
      },
    });
    await runDailyFinalization(deps);
    const written = drivingSummaryCreateCalls[0] as any;
    assert.ok(Math.abs(written.weatherRiskAvg - 0.3) < 1e-9);
    assert.equal(written.weatherSampleCount, 2);
    assert.equal(written.zoneRiskAvg, null);
    assert.equal(written.zoneSampleCount, 0);
  });
});

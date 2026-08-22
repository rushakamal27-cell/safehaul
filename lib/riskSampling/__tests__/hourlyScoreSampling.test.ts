/**
 * Targeted tests for lib/riskSampling/hourlyScoreSampling.ts. All DB/
 * provider dependencies are faked in-memory — no real database or network
 * call is made, same convention as
 * lib/driverContext/__tests__/baselineObservationSync.test.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runHourlyScoreSampling,
  type HourlyScoreSamplingDeps,
  type PilotDriverIdClient,
  type SafetyScoreSampleClient,
} from "../hourlyScoreSampling";
import type { AssembleDriverContextResult } from "@/lib/driverContext/assemble";
import type { DriverContext } from "@/lib/driverContext/types";
import { Prisma } from "@/lib/generated/prisma";

const NOW_ISO = "2026-08-22T14:05:00.000Z";

function field<T>(value: T | null, opts: Partial<DriverContext["hos"]> = {}) {
  return { value, origin: value === null ? null : "observed", state: value === null ? "unavailable" : "fresh", provider: value === null ? null : "samsara", observedAt: value === null ? null : NOW_ISO, ...opts } as any;
}

function fakeAssembled(overrides: Partial<DriverContext> = {}): AssembleDriverContextResult {
  const context: DriverContext = {
    driverId: "driver-1",
    safetyEvents: field<DriverContext["safetyEvents"]["value"]>([]),
    hos: field<number>(3.5),
    speed: field<number>(55),
    weather: field<number>(0.1),
    zoneRisk: field<number>(0),
    location: field<{ latitude: number; longitude: number }>({ latitude: 40.3, longitude: -74.5 }),
    ...overrides,
  };
  return {
    context,
    liveData: null,
    hosDetail: {} as any,
    locationDetail: {} as any,
    weatherDetail: {} as any,
    zoneDetail: {} as any,
    calculatedAt: NOW_ISO,
  };
}

interface HarnessOptions {
  pilotDriverIds: string[];
  /** driverId -> hourBucket ISO already sampled */
  existingSamples?: Record<string, string>;
  assembleOverridesByDriver?: Record<string, Partial<DriverContext>>;
}

function makeHarness(opts: HarnessOptions) {
  const createCalls: unknown[] = [];
  const assembleCalls: string[] = [];

  const pilotDriverIdClient: PilotDriverIdClient = {
    async findMany() {
      return opts.pilotDriverIds.map((driverId) => ({ driverId }));
    },
  };

  const store = new Map<string, string>(Object.entries(opts.existingSamples ?? {}));

  const sampleClient: SafetyScoreSampleClient = {
    async findUnique({ where }) {
      const key = where.driverId_hourBucket.driverId;
      const existing = store.get(key);
      return existing === where.driverId_hourBucket.hourBucket.toISOString() ? { id: `existing-${key}` } : null;
    },
    async create(args) {
      createCalls.push(args.data);
      const data = args.data as any;
      store.set(data.driverId, (data.hourBucket as Date).toISOString());
      return { id: `sample-${createCalls.length}` };
    },
  };

  const deps: HourlyScoreSamplingDeps = {
    pilotDriverIdClient,
    sampleClient,
    now: () => new Date(NOW_ISO),
    assembleDriverContextFn: async (driverId) => {
      assembleCalls.push(driverId);
      return fakeAssembled(opts.assembleOverridesByDriver?.[driverId]);
    },
  };

  return { deps, createCalls, assembleCalls };
}

describe("runHourlyScoreSampling — happy path", () => {
  test("creates one sample for an eligible pilot driver with no existing sample this hour", async () => {
    const { deps, createCalls } = makeHarness({ pilotDriverIds: ["driver-1"] });
    const result = await runHourlyScoreSampling(deps);

    assert.equal(result.driversConsidered, 1);
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);
    assert.equal(createCalls.length, 1);
    const written = createCalls[0] as any;
    assert.equal(written.hourBucket.toISOString(), "2026-08-22T14:00:00.000Z");
    assert.ok(typeof written.score === "number");
  });

  test("partial context (missing HOS) is still sampled, with contextStatus recording the gap — no zero fabrication, no skip", async () => {
    const { deps, createCalls } = makeHarness({
      pilotDriverIds: ["driver-1"],
      assembleOverridesByDriver: { "driver-1": { hos: field<number>(null) } },
    });
    const result = await runHourlyScoreSampling(deps);

    assert.equal(result.created, 1);
    const written = createCalls[0] as any;
    assert.equal(written.contextStatus, "partial_live");
    assert.notEqual(written.score, 0);
  });
});

describe("runHourlyScoreSampling — hourly uniqueness", () => {
  test("two runs in the same driver/hour do not create a duplicate sample", async () => {
    const { deps } = makeHarness({ pilotDriverIds: ["driver-1"] });

    const first = await runHourlyScoreSampling(deps);
    assert.equal(first.created, 1);

    const second = await runHourlyScoreSampling(deps);
    assert.equal(second.created, 0);
    assert.equal(second.skipped, 1);
    assert.deepEqual(second.results[0], { driverId: "driver-1", status: "skipped", reason: "already_sampled" });
  });

  test("a P2002 race on create() (concurrent invocation) is treated as a skip, not a failure", async () => {
    const pilotDriverIdClient: PilotDriverIdClient = { async findMany() { return [{ driverId: "driver-1" }]; } };
    const sampleClient: SafetyScoreSampleClient = {
      async findUnique() { return null; }, // pre-check says "not sampled yet"
      async create() {
        // ...but the actual insert loses a race to a concurrent invocation.
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        });
      },
    };

    const result = await runHourlyScoreSampling({
      pilotDriverIdClient,
      sampleClient,
      now: () => new Date(NOW_ISO),
      assembleDriverContextFn: async () => fakeAssembled(),
    });

    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.results[0], { driverId: "driver-1", status: "skipped", reason: "already_sampled" });
  });
});

describe("runHourlyScoreSampling — hour rollover", () => {
  test("the same driver in two different UTC hours gets two independent samples", async () => {
    const { deps, createCalls } = makeHarness({ pilotDriverIds: ["driver-1"] });

    const first = await runHourlyScoreSampling(deps);
    assert.equal(first.created, 1);

    const second = await runHourlyScoreSampling({ ...deps, now: () => new Date("2026-08-22T15:05:00.000Z") });
    assert.equal(second.created, 1);

    assert.equal(createCalls.length, 2);
    const hourBuckets = createCalls.map((c) => (c as any).hourBucket.toISOString());
    assert.deepEqual(hourBuckets, ["2026-08-22T14:00:00.000Z", "2026-08-22T15:00:00.000Z"]);
  });
});

describe("runHourlyScoreSampling — failure isolation", () => {
  test("one driver's assembly failure does not stop the others", async () => {
    const pilotDriverIdClient: PilotDriverIdClient = {
      async findMany() { return [{ driverId: "driver-1" }, { driverId: "driver-2" }]; },
    };
    const sampleClient: SafetyScoreSampleClient = {
      async findUnique() { return null; },
      async create(args) { return { id: "sample-1", ...(args.data as any) }; },
    };

    const result = await runHourlyScoreSampling({
      pilotDriverIdClient,
      sampleClient,
      now: () => new Date(NOW_ISO),
      assembleDriverContextFn: async (driverId) => {
        if (driverId === "driver-1") throw new Error("simulated provider failure");
        return fakeAssembled();
      },
    });

    assert.equal(result.driversConsidered, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.created, 1);
  });
});

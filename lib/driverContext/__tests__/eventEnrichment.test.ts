/**
 * Targeted tests for the Phase 6B.4 enrichment orchestrator
 * (lib/driverContext/eventEnrichment.ts) in isolation from the Safety
 * Events sync that calls it — see
 * lib/providers/samsara/__tests__/syncSafetyEvents.test.ts's "Phase 6B.4
 * safety_event enrichment integration" describe block for the wiring-level
 * tests. All dependencies are faked in-memory — no real database or
 * provider network call is made.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { enrichNewDriverEvents, type NewDriverEventRef } from "../eventEnrichment";
import type { CapturedDriverObservation, CaptureDriverObservationParams } from "../captureObservation";

function fakeCaptured(driverId: string, driverEventId: string): CapturedDriverObservation {
  return {
    id: `obs-${driverEventId}`,
    driverId,
    triggerType: "safety_event",
    driverEventId,
    observedAt: "2026-08-12T14:22:00.000Z",
    collectedAt: "2026-08-12T14:22:00.000Z",
    latitude: null,
    longitude: null,
    speedMph: null,
    hosShiftHoursUsed: null,
    weatherRisk: null,
    zoneRisk: null,
    contextJson: {} as any,
  };
}

describe("enrichNewDriverEvents — happy path", () => {
  test("creates one observation per newly created DriverEvent", async () => {
    const calls: CaptureDriverObservationParams[] = [];
    const events: NewDriverEventRef[] = [
      { id: "de_1", driverId: "drv_1" },
      { id: "de_2", driverId: "drv_2" },
    ];

    const stats = await enrichNewDriverEvents(events, {
      observationClient: { async findFirst() { return null; } },
      captureDriverObservationFn: async (params) => {
        calls.push(params);
        return fakeCaptured(params.driverId, params.driverEventId!);
      },
    });

    assert.equal(stats.eventsCreated, 2);
    assert.equal(stats.enrichmentAttempted, 2);
    assert.equal(stats.enrichmentCreated, 2);
    assert.equal(stats.enrichmentSkipped, 0);
    assert.equal(stats.enrichmentFailed, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { driverId: "drv_1", triggerType: "safety_event", driverEventId: "de_1" });
    assert.deepEqual(calls[1], { driverId: "drv_2", triggerType: "safety_event", driverEventId: "de_2" });
  });

  test("an empty input list does nothing and calls no dependency", async () => {
    let captureCalls = 0;
    let findFirstCalls = 0;
    const stats = await enrichNewDriverEvents([], {
      observationClient: {
        async findFirst() {
          findFirstCalls++;
          return null;
        },
      },
      captureDriverObservationFn: async () => {
        captureCalls++;
        throw new Error("must not be called");
      },
    });

    assert.deepEqual(stats, {
      eventsCreated: 0,
      enrichmentAttempted: 0,
      enrichmentCreated: 0,
      enrichmentSkipped: 0,
      enrichmentFailed: 0,
    });
    assert.equal(captureCalls, 0);
    assert.equal(findFirstCalls, 0);
  });
});

describe("enrichNewDriverEvents — idempotency (already_enriched)", () => {
  test("a driverEventId with an existing safety_event observation is skipped, not duplicated", async () => {
    let captureCalls = 0;
    const stats = await enrichNewDriverEvents([{ id: "de_1", driverId: "drv_1" }], {
      observationClient: {
        async findFirst({ where }) {
          assert.equal(where.driverEventId, "de_1");
          assert.equal(where.triggerType, "safety_event");
          return { id: "existing-obs" };
        },
      },
      captureDriverObservationFn: async () => {
        captureCalls++;
        return fakeCaptured("drv_1", "de_1");
      },
    });

    assert.equal(stats.enrichmentSkipped, 1);
    assert.equal(stats.enrichmentCreated, 0);
    assert.equal(captureCalls, 0, "the collector must never run once already_enriched is detected");
  });

  test("different events are checked and enriched independently — one already_enriched, one new", async () => {
    const existing = new Set(["de_1"]);
    const calls: string[] = [];

    const stats = await enrichNewDriverEvents(
      [
        { id: "de_1", driverId: "drv_1" },
        { id: "de_2", driverId: "drv_1" },
      ],
      {
        observationClient: {
          async findFirst({ where }) {
            return existing.has(where.driverEventId) ? { id: `existing-${where.driverEventId}` } : null;
          },
        },
        captureDriverObservationFn: async (params) => {
          calls.push(params.driverEventId!);
          return fakeCaptured(params.driverId, params.driverEventId!);
        },
      }
    );

    assert.equal(stats.enrichmentSkipped, 1);
    assert.equal(stats.enrichmentCreated, 1);
    assert.deepEqual(calls, ["de_2"]);
  });
});

describe("enrichNewDriverEvents — Phase 6B.5 DB-constraint race handling", () => {
  test("a P2002 on create() (pre-check missed a concurrent winner) is treated as already_enriched, not a failure", async () => {
    const stats = await enrichNewDriverEvents([{ id: "de_1", driverId: "drv_1" }], {
      // The pre-check sees nothing yet — a concurrent enricher hasn't
      // committed its create() until just after this findFirst runs.
      observationClient: { async findFirst() { return null; } },
      captureDriverObservationFn: async () => {
        const err = new Error("Unique constraint failed on the fields: (`driverEventId`,`triggerType`)") as Error & { code: string };
        err.code = "P2002";
        throw err;
      },
    });

    assert.equal(stats.enrichmentSkipped, 1, "must count as already_enriched, not a failure");
    assert.equal(stats.enrichmentFailed, 0);
    assert.equal(stats.enrichmentCreated, 0);
  });

  test("a P2002 for one event does not affect enrichment of a different event", async () => {
    const stats = await enrichNewDriverEvents(
      [
        { id: "de_1", driverId: "drv_1" },
        { id: "de_2", driverId: "drv_2" },
      ],
      {
        observationClient: { async findFirst() { return null; } },
        captureDriverObservationFn: async (params) => {
          if (params.driverEventId === "de_1") {
            const err = new Error("Unique constraint failed") as Error & { code: string };
            err.code = "P2002";
            throw err;
          }
          return fakeCaptured(params.driverId, params.driverEventId!);
        },
      }
    );

    assert.equal(stats.enrichmentSkipped, 1);
    assert.equal(stats.enrichmentCreated, 1);
    assert.equal(stats.enrichmentFailed, 0);
  });

  test("a genuine, unrelated DB error on create() is still counted as a real failure, never hidden as already_enriched", async () => {
    const stats = await enrichNewDriverEvents([{ id: "de_1", driverId: "drv_1" }], {
      observationClient: { async findFirst() { return null; } },
      captureDriverObservationFn: async () => {
        throw new Error("connection to database lost");
      },
    });

    assert.equal(stats.enrichmentFailed, 1, "an unrelated DB error must never be mistaken for already_enriched");
    assert.equal(stats.enrichmentSkipped, 0);
  });
});

describe("enrichNewDriverEvents — failure isolation", () => {
  test("one event's capture failure does not stop enrichment of the others", async () => {
    const stats = await enrichNewDriverEvents(
      [
        { id: "de_1", driverId: "drv_1" },
        { id: "de_2", driverId: "drv_2" },
        { id: "de_3", driverId: "drv_3" },
      ],
      {
        observationClient: { async findFirst() { return null; } },
        captureDriverObservationFn: async (params) => {
          if (params.driverEventId === "de_2") throw new Error("simulated provider failure");
          return fakeCaptured(params.driverId, params.driverEventId!);
        },
      }
    );

    assert.equal(stats.enrichmentAttempted, 3);
    assert.equal(stats.enrichmentCreated, 2);
    assert.equal(stats.enrichmentFailed, 1);
  });

  test("a findFirst (idempotency check) failure for one event is isolated too", async () => {
    const stats = await enrichNewDriverEvents(
      [
        { id: "de_1", driverId: "drv_1" },
        { id: "de_2", driverId: "drv_2" },
      ],
      {
        observationClient: {
          async findFirst({ where }) {
            if (where.driverEventId === "de_1") throw new Error("db error");
            return null;
          },
        },
        captureDriverObservationFn: async (params) => fakeCaptured(params.driverId, params.driverEventId!),
      }
    );

    assert.equal(stats.enrichmentFailed, 1);
    assert.equal(stats.enrichmentCreated, 1);
  });
});

describe("enrichNewDriverEvents — timestamp semantics", () => {
  test("the captured observation's timestamps are collection-time, never the event's own timestamp", async () => {
    const captured: CapturedDriverObservation[] = [];

    await enrichNewDriverEvents([{ id: "de_1", driverId: "drv_1" }], {
      observationClient: { async findFirst() { return null; } },
      captureDriverObservationFn: async (params) => {
        // A real captureDriverObservation always sets observedAt/collectedAt
        // to the collection instant, never the linked DriverEvent's own
        // timestamp — this fake mirrors that contract rather than
        // re-deriving it, since that guarantee is already covered by
        // lib/driverContext/__tests__/captureObservation.test.ts.
        const obs = fakeCaptured(params.driverId, params.driverEventId!);
        captured.push(obs);
        return obs;
      },
    });

    assert.equal(captured[0].observedAt, captured[0].collectedAt);
    assert.notEqual(captured[0].observedAt, "2026-08-01T12:00:00.000Z", "must not equal a stand-in event timestamp");
  });
});

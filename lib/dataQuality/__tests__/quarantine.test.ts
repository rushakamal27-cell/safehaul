import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isHistoricalDataQuarantined,
  findQuarantineEntry,
  QUARANTINE_ENTRIES,
  type QuarantinableDataType,
} from "../quarantine";

// The one real entry (Phase 6D closure): driver cmnq65l6c0001nytoxvfipwt9 had
// context sourced from the wrong truck. Range starts 2026-09-04T00:00:00Z
// inclusive and ends at the exclusive, production-verified bound
// 2026-10-07T17:20:03.621Z — the instant of her first observation confirmed to
// cite TRUCK 284 (281475006503539) via vehicleIdSource "driver_event".
const RUSHANA = "cmnq65l6c0001nytoxvfipwt9";
const OTHER_DRIVER = "cmnqiauan00011bod8vd2f0kz"; // Temurbek — never quarantined

const q = (driverId: string, dataType: QuarantinableDataType, iso: string) =>
  isHistoricalDataQuarantined({ driverId, dataType, at: new Date(iso) });

describe("isHistoricalDataQuarantined — Rushana wrong_vehicle_attribution range", () => {
  test("a date inside the confirmed-contaminated window is quarantined", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-09-25T13:00:00.000Z"), true);
  });

  test("a date inside the indeterminate window is also quarantined (deliberately wider)", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-09-10T08:30:00.000Z"), true);
  });

  test("before the range is NOT quarantined", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-09-03T23:59:59.999Z"), false);
  });

  test("after the range is NOT quarantined", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-08T00:00:00.000Z"), false);
  });

  test("the last confirmed contaminated observation is quarantined", () => {
    // Production: providerVehicleId 281474991238949 ("TRUCK 226"),
    // vehicleIdSource "provider_mapping", 1,533 mi from her own events.
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-07T17:00:03.191Z"), true);
  });

  test("the last confirmed contaminated sample is quarantined (hourBucket 17:00Z)", () => {
    assert.equal(q(RUSHANA, "SafetyScoreSample", "2026-10-07T17:00:00.000Z"), true);
  });

  test("the first confirmed CLEAN observation is admitted — it IS the exclusive bound", () => {
    // Production: providerVehicleId 281475006503539 ("TRUCK 284"),
    // vehicleIdSource "driver_event".
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-07T17:20:03.621Z"), false);
  });

  test("one millisecond BEFORE the clean row is still quarantined (exclusive-end precision)", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-07T17:20:03.620Z"), true);
  });

  test("the first admitted sample (hourBucket 18:00Z, verified clean) is NOT quarantined", () => {
    assert.equal(q(RUSHANA, "SafetyScoreSample", "2026-10-07T18:00:00.000Z"), false);
  });

  test("her verified-clean post-fix evening observations are admitted, not discarded", () => {
    for (const iso of [
      "2026-10-07T17:40:00.000Z",
      "2026-10-07T18:20:03.281Z",
      "2026-10-07T20:00:00.000Z",
      "2026-10-07T23:59:59.999Z",
    ]) {
      assert.equal(q(RUSHANA, "DriverObservation", iso), false, `${iso} must be admitted`);
    }
  });

  test("the 2026-10-07 daily rows stay quarantined — that day mixes 18 contaminated hours with 6 clean ones", () => {
    // Daily buckets are UTC midnight, which is below the bound, so the mixed
    // day is correctly excluded rather than partially trusted.
    assert.equal(q(RUSHANA, "DailySafetyScore", "2026-10-07T00:00:00.000Z"), true);
    assert.equal(q(RUSHANA, "DailyDrivingSummary", "2026-10-07T00:00:00.000Z"), true);
  });

  test("the 2026-10-08 daily rows are admitted — first fully post-fix day", () => {
    assert.equal(q(RUSHANA, "DailySafetyScore", "2026-10-08T00:00:00.000Z"), false);
    assert.equal(q(RUSHANA, "DailyDrivingSummary", "2026-10-08T00:00:00.000Z"), false);
  });

  test("a much earlier date for the same driver is clean", () => {
    assert.equal(q(RUSHANA, "SafetyScoreSample", "2026-08-15T12:00:00.000Z"), false);
  });

  test("a different driver inside the SAME date range is never affected", () => {
    assert.equal(q(OTHER_DRIVER, "DriverObservation", "2026-09-25T13:00:00.000Z"), false);
    assert.equal(q(OTHER_DRIVER, "SafetyScoreSample", "2026-09-25T13:00:00.000Z"), false);
    assert.equal(q(OTHER_DRIVER, "DailySafetyScore", "2026-09-25T00:00:00.000Z"), false);
  });
});

describe("isHistoricalDataQuarantined — UTC boundary correctness", () => {
  test("the first instant of the range is INCLUSIVE", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-09-04T00:00:00.000Z"), true);
  });

  test("one millisecond before the range start is excluded", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-09-03T23:59:59.999Z"), false);
  });

  test("the final millisecond before the exclusive bound is INCLUDED", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-07T17:20:03.620Z"), true);
  });

  test("the exclusive end instant itself is excluded", () => {
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-07T17:20:03.621Z"), false);
  });

  test("the bound is millisecond-precise, not rounded to the second or minute", () => {
    // A bound rounded down to 17:20:03.000Z or 17:20:00.000Z would wrongly
    // admit rows in the preceding fraction; one rounded up to 17:20:04.000Z
    // would wrongly quarantine the verified-clean row itself.
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-07T17:20:03.000Z"), true);
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-07T17:20:00.000Z"), true);
    assert.equal(q(RUSHANA, "DriverObservation", "2026-10-07T17:20:03.622Z"), false);
  });

  test("a UTC-midnight daily-row date below the bound is included", () => {
    // DailySafetyScore / DailyDrivingSummary buckets are UTC midnight.
    assert.equal(q(RUSHANA, "DailySafetyScore", "2026-10-07T00:00:00.000Z"), true);
    assert.equal(q(RUSHANA, "DailyDrivingSummary", "2026-10-07T00:00:00.000Z"), true);
  });

  test("comparison is on absolute instants, not local wall-clock", () => {
    // 2026-10-07T17:20:03.620Z is a different calendar date in some local
    // zones; classification must depend only on the absolute instant.
    assert.equal(q(RUSHANA, "SafetyScoreSample", "2026-10-07T17:00:00.000Z"), true);
    assert.equal(q(RUSHANA, "SafetyScoreSample", "2026-10-07T18:00:00.000Z"), false);
    // An instant well past the bound must not match, regardless of zone.
    assert.equal(q(RUSHANA, "SafetyScoreSample", "2026-10-08T00:00:00.001Z"), false);
  });
});

describe("isHistoricalDataQuarantined — data-type scoping", () => {
  test("DriverEvent remains USABLE inside the range — provider payload carries its own attribution", () => {
    assert.equal(q(RUSHANA, "DriverEvent", "2026-09-25T13:00:00.000Z"), false);
    assert.equal(q(RUSHANA, "DriverEvent", "2026-10-07T23:59:59.999Z"), false);
  });

  test("all four context-derived record types ARE quarantined inside the range", () => {
    for (const dataType of [
      "DriverObservation",
      "SafetyScoreSample",
      "DailySafetyScore",
      "DailyDrivingSummary",
    ] as QuarantinableDataType[]) {
      assert.equal(q(RUSHANA, dataType, "2026-09-25T13:00:00.000Z"), true, `${dataType} must be quarantined`);
    }
  });

  test("record types not listed on the entry are not quarantined", () => {
    assert.equal(q(RUSHANA, "Trip", "2026-09-25T13:00:00.000Z"), false);
    assert.equal(q(RUSHANA, "ComplianceScore", "2026-09-25T13:00:00.000Z"), false);
  });
});

describe("findQuarantineEntry — reportable reason", () => {
  test("returns the matching entry with a machine-readable reason", () => {
    const entry = findQuarantineEntry({
      driverId: RUSHANA,
      dataType: "SafetyScoreSample",
      at: new Date("2026-09-25T13:00:00.000Z"),
    });
    assert.ok(entry);
    assert.equal(entry!.reason, "wrong_vehicle_attribution");
    assert.equal(entry!.driverId, RUSHANA);
  });

  test("returns null when nothing matches", () => {
    assert.equal(
      findQuarantineEntry({ driverId: OTHER_DRIVER, dataType: "SafetyScoreSample", at: new Date("2026-09-25T13:00:00.000Z") }),
      null
    );
  });
});

describe("QUARANTINE_ENTRIES integrity", () => {
  test("every entry identifies its driver by internal id, never a name", () => {
    for (const e of QUARANTINE_ENTRIES) {
      assert.match(e.driverId, /^c[a-z0-9]{20,}$/, "driverId must be a cuid, not a human name");
    }
  });

  test("every entry has a well-ordered range", () => {
    for (const e of QUARANTINE_ENTRIES) {
      if (e.toExclusive !== null) {
        assert.ok(e.toExclusive.getTime() > e.fromInclusive.getTime(), "end must be after start");
      }
    }
  });

  test("no entry quarantines DriverEvent (provider-attributed, unaffected by vehicle resolution)", () => {
    for (const e of QUARANTINE_ENTRIES) {
      assert.equal(e.affects.includes("DriverEvent"), false);
    }
  });
});

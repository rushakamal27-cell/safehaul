import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { utcPreviousDayBounds, utcHourBucket, utcDayKey } from "../dayBounds";

describe("utcPreviousDayBounds", () => {
  test("returns [yesterday 00:00Z, today 00:00Z) when run just after UTC midnight", () => {
    const now = new Date("2026-08-23T00:10:00.000Z");
    const { start, end } = utcPreviousDayBounds(now);
    assert.equal(start.toISOString(), "2026-08-22T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-08-23T00:00:00.000Z");
  });

  test("an observation exactly at the previous day's UTC midnight is INCLUDED (start is inclusive)", () => {
    const now = new Date("2026-08-23T00:10:00.000Z");
    const { start } = utcPreviousDayBounds(now);
    const boundaryInstant = new Date("2026-08-22T00:00:00.000Z");
    assert.ok(boundaryInstant.getTime() >= start.getTime());
  });

  test("an observation exactly at the day's own UTC midnight (start of today) is EXCLUDED (end is exclusive)", () => {
    const now = new Date("2026-08-23T00:10:00.000Z");
    const { end } = utcPreviousDayBounds(now);
    const boundaryInstant = new Date("2026-08-23T00:00:00.000Z");
    assert.ok(boundaryInstant.getTime() >= end.getTime());
    // The range check itself: gte start && lt end must exclude this instant.
    assert.equal(boundaryInstant.getTime() < end.getTime(), false);
  });

  test("still resolves the correct previous day when run well into the next day (late/missed cron)", () => {
    const now = new Date("2026-08-23T14:00:00.000Z");
    const { start, end } = utcPreviousDayBounds(now);
    assert.equal(start.toISOString(), "2026-08-22T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-08-23T00:00:00.000Z");
  });
});

describe("utcHourBucket", () => {
  test("zeroes minutes/seconds/ms, keeps the hour", () => {
    const now = new Date("2026-08-22T14:37:52.123Z");
    assert.equal(utcHourBucket(now).toISOString(), "2026-08-22T14:00:00.000Z");
  });

  test("an instant already exactly on the hour is unchanged", () => {
    const now = new Date("2026-08-22T14:00:00.000Z");
    assert.equal(utcHourBucket(now).toISOString(), "2026-08-22T14:00:00.000Z");
  });

  test("two instants in the same clock hour map to the identical bucket (hourly uniqueness precondition)", () => {
    const a = utcHourBucket(new Date("2026-08-22T14:01:00.000Z"));
    const b = utcHourBucket(new Date("2026-08-22T14:59:59.999Z"));
    assert.equal(a.getTime(), b.getTime());
  });

  test("two instants in different clock hours map to different buckets (hour rollover)", () => {
    const a = utcHourBucket(new Date("2026-08-22T14:59:59.999Z"));
    const b = utcHourBucket(new Date("2026-08-22T15:00:00.000Z"));
    assert.notEqual(a.getTime(), b.getTime());
  });
});

describe("utcDayKey", () => {
  test("formats as YYYY-MM-DD", () => {
    assert.equal(utcDayKey(new Date("2026-08-22T14:37:52.123Z")), "2026-08-22");
  });

  test("UTC midnight belongs to the day it starts, not the day before", () => {
    assert.equal(utcDayKey(new Date("2026-08-22T00:00:00.000Z")), "2026-08-22");
  });
});

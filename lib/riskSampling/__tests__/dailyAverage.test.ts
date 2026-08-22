import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeDailyAverage } from "../dailyAverage";

describe("computeDailyAverage", () => {
  test("24 valid samples divides by 24", () => {
    const scores = Array.from({ length: 24 }, () => 90);
    const result = computeDailyAverage(scores);
    assert.equal(result?.sampleCount, 24);
    assert.equal(result?.average, 90);
  });

  test("21 valid samples divides by 21, NOT 24 — the critical denominator rule", () => {
    const scores = Array.from({ length: 21 }, () => 84);
    const result = computeDailyAverage(scores);
    assert.equal(result?.sampleCount, 21);
    assert.equal(result?.average, 84);
    // Sanity: dividing by 24 instead would have produced a different (lower) number.
    assert.notEqual(result!.average, (84 * 21) / 24);
  });

  test("worked example: 100, 80, 60 -> 80", () => {
    const result = computeDailyAverage([100, 80, 60]);
    assert.equal(result?.average, 80);
    assert.equal(result?.sampleCount, 3);
  });

  test("no zero fabrication: an empty input returns null, never a 0-sample average", () => {
    const result = computeDailyAverage([]);
    assert.equal(result, null);
  });

  test("a missing sample is simply absent, not counted as 0 — 100 and 80 average to 90, not 60", () => {
    const result = computeDailyAverage([100, 80]);
    assert.equal(result?.average, 90);
  });
});

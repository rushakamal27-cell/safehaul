import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nextRunningAverage } from "../complianceScoreAverage";

describe("nextRunningAverage", () => {
  test("first sample: average equals the score, count is 1", () => {
    const { average, sampleCount } = nextRunningAverage(0, 0, 100);
    assert.equal(average, 100);
    assert.equal(sampleCount, 1);
  });

  test("100 then 80 -> average 90, count 2", () => {
    let state = nextRunningAverage(0, 0, 100);
    state = nextRunningAverage(state.average, state.sampleCount, 80);
    assert.equal(state.average, 90);
    assert.equal(state.sampleCount, 2);
  });

  test("100, 80, 90 -> average 90, count 3", () => {
    let state = nextRunningAverage(0, 0, 100);
    state = nextRunningAverage(state.average, state.sampleCount, 80);
    state = nextRunningAverage(state.average, state.sampleCount, 90);
    assert.equal(state.average, 90);
    assert.equal(state.sampleCount, 3);
  });

  // The task's canonical example proving this is a true running mean, not
  // naive pairwise re-averaging (which would incorrectly produce 75 here:
  // avg(avg(100,80),60) = avg(90,60) = 75 — silently halving the weight of
  // the first two samples on every new arrival).
  test("100, 80, 60 -> mathematically correct average is 80, not the pairwise-wrong 75", () => {
    let state = nextRunningAverage(0, 0, 100);
    state = nextRunningAverage(state.average, state.sampleCount, 80);
    state = nextRunningAverage(state.average, state.sampleCount, 60);
    assert.equal(state.average, 80);
    assert.notEqual(state.average, 75);
    assert.equal(state.sampleCount, 3);
  });

  // The task's other worked example: 99, 91, 94, 88 -> 93.
  test("99, 91, 94, 88 -> average 93, count 4", () => {
    let state = nextRunningAverage(0, 0, 99);
    state = nextRunningAverage(state.average, state.sampleCount, 91);
    assert.equal(state.average, 95);
    state = nextRunningAverage(state.average, state.sampleCount, 94);
    assert.ok(Math.abs(state.average - 94.6666666) < 1e-6);
    state = nextRunningAverage(state.average, state.sampleCount, 88);
    assert.equal(state.average, 93);
    assert.equal(state.sampleCount, 4);
  });

  test("sampleCount increments exactly once per incorporated score, regardless of average value", () => {
    let state = { average: 50, sampleCount: 7 };
    state = nextRunningAverage(state.average, state.sampleCount, 50);
    assert.equal(state.sampleCount, 8);
  });

  test("matches a plain sum/count average for an arbitrary longer sequence", () => {
    const scores = [72, 88, 91, 65, 100, 40, 83];
    let state = { average: 0, sampleCount: 0 };
    for (const score of scores) {
      state = nextRunningAverage(state.average, state.sampleCount, score);
    }
    const expected = scores.reduce((a, b) => a + b, 0) / scores.length;
    assert.ok(Math.abs(state.average - expected) < 1e-9);
    assert.equal(state.sampleCount, scores.length);
  });
});

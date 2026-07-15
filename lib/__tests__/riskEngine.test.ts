import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculateRisk } from "../riskEngine";

describe("calculateRisk — null hosHours (HOS unknown)", () => {
  test("applies no fatigue penalty and no rest-break recommendation", () => {
    const result = calculateRisk({
      safetyEvents: [],
      hosHours: null,
      weatherRisk: 0,
      zoneRisk: 0,
      speed: 60,
    });
    assert.equal(result.score, 100);
    assert.deepEqual(result.factors, []);
    assert.ok(!result.recommendations.includes("Consider a rest break soon."));
  });

  test("does not crash when other factors are present alongside null hos", () => {
    const result = calculateRisk({
      safetyEvents: [{ type: "harsh_braking", severity: 3 }],
      hosHours: null,
      weatherRisk: 0.6,
      zoneRisk: 0,
      speed: 60,
    });
    assert.ok(!result.factors.some((f) => f.name === "Fatigue"));
  });
});

describe("calculateRisk — known hosHours (unchanged behavior)", () => {
  test("hosHours > 8 still applies a fatigue penalty and recommendation", () => {
    const result = calculateRisk({
      safetyEvents: [],
      hosHours: 12,
      weatherRisk: 0,
      zoneRisk: 0,
      speed: 60,
    });
    assert.ok(result.score < 100);
    assert.ok(result.factors.some((f) => f.name === "Fatigue"));
    assert.ok(result.recommendations.includes("Consider a rest break soon."));
  });

  test("hosHours <= 8 applies no fatigue penalty", () => {
    const result = calculateRisk({
      safetyEvents: [],
      hosHours: 5,
      weatherRisk: 0,
      zoneRisk: 0,
      speed: 60,
    });
    assert.equal(result.score, 100);
    assert.deepEqual(result.factors, []);
  });
});

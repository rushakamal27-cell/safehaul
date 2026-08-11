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
      speed: 0, // no continuous speed exposure at 0mph — isolates the hosHours behavior under test
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
      speed: 0,
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
      speed: 0,
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
      speed: 0,
    });
    assert.equal(result.score, 100);
    assert.deepEqual(result.factors, []);
  });
});

// ---------------------------------------------------------------------------
// Contextual Speed (Phase 4.5) — continuous speed-exposure refinement
//
// Replaces the fixed `speed > 70` cliff with calculateSpeedExposure, a
// continuous piecewise-linear curve (see lib/riskEngine.ts's Contextual
// Speed header comment for the anchor points and rationale). Expected
// exposure values below were verified by direct calculation against
// SPEED_EXPOSURE_ANCHORS, not hand-guessed:
//   0–20 mph → 0; 35 → 0.9; 45 → 1.5; 55 → 2.75; 65 → 4;
//   69 → 4.8; 70 → 5.0; 71 → 5.2; 75 → 6; 80 → 7; 90 → 9; clamp(120+) → 15.
// ---------------------------------------------------------------------------

describe("calculateRisk — Contextual Speed (continuous exposure)", () => {
  const low = { weatherRisk: 0, zoneRisk: 0, hosHours: 4, safetyEvents: [] as { type: string; severity: number }[] };

  test("1. zero speed produces zero exposure", () => {
    const result = calculateRisk({ ...low, speed: 0 });
    assert.equal(result.contextualSpeed.speedExposure, 0);
    assert.equal(result.contextualSpeed.active, false);
    assert.equal(result.score, 100);
  });

  test("2. negative speed is handled safely (floors to 0 exposure, not a crash or fabricated penalty)", () => {
    const result = calculateRisk({ ...low, speed: -10 });
    assert.equal(result.contextualSpeed.speedExposure, 0);
    assert.equal(result.contextualSpeed.finalPenalty, 0);
    assert.equal(result.score, 100);
  });

  test("3. exposure increases monotonically with speed across the plausible domain [0, MAX_PLAUSIBLE_SPEED_MPH]", () => {
    // 150mph is deliberately excluded — beyond the plausible domain it's
    // "invalid telemetry, reject to 0" (see the plausibility boundary
    // describe block below), not part of the monotonic curve.
    const speeds = [0, 15, 20, 35, 45, 55, 65, 75, 90, 120];
    const exposures = speeds.map((speed) => calculateRisk({ ...low, speed }).contextualSpeed.speedExposure);
    for (let i = 1; i < exposures.length; i++) {
      assert.ok(exposures[i] >= exposures[i - 1], `exposure at ${speeds[i]}mph (${exposures[i]}) should be >= at ${speeds[i - 1]}mph (${exposures[i - 1]})`);
    }
  });

  test("4. no discontinuity at the old 70 mph cliff", () => {
    const at69 = calculateRisk({ ...low, speed: 69 }).contextualSpeed.speedExposure;
    const at70 = calculateRisk({ ...low, speed: 70 }).contextualSpeed.speedExposure;
    const at71 = calculateRisk({ ...low, speed: 71 }).contextualSpeed.speedExposure;
    // A 1mph step anywhere on the curve moves exposure by at most one segment's slope (0.2/mph, the steepest segment) — nowhere near the old cliff's full 10.5-point jump from 69->71.
    assert.ok(Math.abs(at70 - at69) <= 0.2 + 1e-9);
    assert.ok(Math.abs(at71 - at70) <= 0.2 + 1e-9);
  });

  test("5. 69, 70, and 71 mph produce nearby progressive values", () => {
    assert.equal(calculateRisk({ ...low, speed: 69 }).contextualSpeed.speedExposure, 4.8);
    assert.equal(calculateRisk({ ...low, speed: 70 }).contextualSpeed.speedExposure, 5.0);
    assert.equal(calculateRisk({ ...low, speed: 71 }).contextualSpeed.speedExposure, 5.2);
  });

  test("6. moderate speed with low context produces a modest penalty (65mph, no amplification)", () => {
    const result = calculateRisk({ ...low, speed: 65 });
    assert.equal(result.contextualSpeed.speedExposure, 4);
    assert.equal(result.contextualSpeed.multiplier, 1);
    assert.equal(result.contextualSpeed.finalPenalty, 4);
    assert.equal(result.score, 96); // modest — not a large chunk of the 100-point budget
  });

  test("7. moderate speed with severe weather produces a larger penalty", () => {
    const result = calculateRisk({ ...low, speed: 65, weatherRisk: 1 });
    assert.equal(result.contextualSpeed.multiplier, 1.5);
    assert.equal(result.contextualSpeed.finalPenalty, 6);
    assert.ok(result.contextualSpeed.finalPenalty > 4);
  });

  test("8. moderate speed with high zone risk produces a larger penalty", () => {
    const result = calculateRisk({ ...low, speed: 65, zoneRisk: 1 });
    assert.equal(result.contextualSpeed.multiplier, 1.4);
    assert.equal(result.contextualSpeed.finalPenalty, 5.6);
  });

  test("9. moderate speed with fatigue produces a larger penalty", () => {
    const result = calculateRisk({ ...low, speed: 65, hosHours: 14 });
    assert.equal(result.contextualSpeed.multiplier, 1.3);
    assert.equal(result.contextualSpeed.finalPenalty, 5.2);
  });

  test("10. recent distraction amplifies speed exposure", () => {
    const result = calculateRisk({ ...low, speed: 65, safetyEvents: [{ type: "mobile_usage", severity: 5 }] });
    assert.equal(result.contextualSpeed.multiplier, 1.1);
    assert.ok(Math.abs(result.contextualSpeed.finalPenalty - 4.4) < 1e-9);
  });

  test("11. unavailable context does not amplify the speed exposure, even with a misleading nonzero value underneath", () => {
    const result = calculateRisk({
      ...low, speed: 90, weatherRisk: 0.95, zoneRisk: 0.95,
      weatherAvailable: false, zoneRiskAvailable: false,
    });
    assert.equal(result.contextualSpeed.multiplier, 1);
    assert.equal(result.contextualSpeed.finalPenalty, result.contextualSpeed.speedExposure);
    assert.equal(result.contextualSpeed.contextComplete, false);
    assert.deepEqual(result.contextualSpeed.missingContext, ["Weather", "Zone risk"]);
  });

  test("12. unavailable speed (defaulted to 0 upstream) produces no contextual speed penalty", () => {
    const result = calculateRisk({ ...low, speed: 0, weatherRisk: 0.9, zoneRisk: 0.9, hosHours: 14 });
    assert.equal(result.contextualSpeed.active, false);
    assert.equal(result.contextualSpeed.finalPenalty, 0);
  });

  test("13. extreme malformed speed is REJECTED, not clamped to max exposure — a driver is never penalized for corrupted telemetry", () => {
    const extreme = calculateRisk({ ...low, speed: 99999 }).contextualSpeed;
    assert.equal(extreme.speedExposure, 0);
    assert.equal(extreme.finalPenalty, 0);
    assert.equal(extreme.active, false);
  });

  // ---------------------------------------------------------------------------
  // Plausibility boundary: MAX_PLAUSIBLE_SPEED_MPH (120) separates "a valid,
  // extreme speed" from "invalid/implausible telemetry." Values at or below
  // the boundary are scored normally; anything above, non-finite, or
  // negative is rejected outright (0 exposure), never clamped into range.
  // ---------------------------------------------------------------------------
  describe("speed plausibility boundary (MAX_PLAUSIBLE_SPEED_MPH)", () => {
    test("1. 120 mph (the plausible maximum) produces the maximum bounded exposure", () => {
      const result = calculateRisk({ ...low, speed: 120 });
      assert.equal(result.contextualSpeed.speedExposure, 15);
      assert.equal(result.contextualSpeed.active, true);
    });

    test("2. a value above the plausible maximum (121 mph) produces zero exposure", () => {
      const result = calculateRisk({ ...low, speed: 121 });
      assert.equal(result.contextualSpeed.speedExposure, 0);
      assert.equal(result.contextualSpeed.active, false);
    });

    test("3. 99999 mph produces zero exposure", () => {
      const result = calculateRisk({ ...low, speed: 99999 });
      assert.equal(result.contextualSpeed.speedExposure, 0);
    });

    test("4. NaN produces zero exposure", () => {
      const result = calculateRisk({ ...low, speed: NaN });
      assert.equal(result.contextualSpeed.speedExposure, 0);
      assert.equal(Number.isFinite(result.score), true);
    });

    test("5. positive infinity produces zero exposure", () => {
      const result = calculateRisk({ ...low, speed: Infinity });
      assert.equal(result.contextualSpeed.speedExposure, 0);
      assert.equal(Number.isFinite(result.score), true);
    });

    test("5b. negative infinity produces zero exposure", () => {
      const result = calculateRisk({ ...low, speed: -Infinity });
      assert.equal(result.contextualSpeed.speedExposure, 0);
      assert.equal(Number.isFinite(result.score), true);
    });

    test("6. negative speed produces zero exposure", () => {
      const result = calculateRisk({ ...low, speed: -10 });
      assert.equal(result.contextualSpeed.speedExposure, 0);
    });

    test("7. invalid speed does not activate the Contextual Speed card", () => {
      for (const speed of [NaN, Infinity, -5, 99999, 121]) {
        assert.equal(calculateRisk({ ...low, speed }).contextualSpeed.active, false, `speed=${speed} should not activate Contextual Speed`);
      }
    });

    test("8. invalid speed cannot be amplified by weather, zone, fatigue, or behavior", () => {
      const result = calculateRisk({
        weatherRisk: 1, zoneRisk: 1, hosHours: 14,
        safetyEvents: [{ type: "harsh_braking", severity: 5 }],
        speed: 99999,
      });
      // The multiplier is still computed (weather/zone/fatigue/behavior are
      // independent of speed), but with 0 exposure to multiply, the final
      // contextual speed penalty is 0 regardless of how large the multiplier is.
      assert.ok(result.contextualSpeed.multiplier > 1);
      assert.equal(result.contextualSpeed.speedExposure, 0);
      assert.equal(result.contextualSpeed.finalPenalty, 0);
      assert.equal(result.contextualSpeed.active, false);
    });

    test("9. valid speed behavior is unchanged (65mph, 90mph still score as before)", () => {
      assert.equal(calculateRisk({ ...low, speed: 65 }).contextualSpeed.speedExposure, 4);
      assert.equal(calculateRisk({ ...low, speed: 90 }).contextualSpeed.speedExposure, 9);
    });
  });

  test("14. multiplier cap is still enforced after the exposure formula change", () => {
    const result = calculateRisk({
      safetyEvents: [
        { type: "mobile_usage", severity: 5 },
        { type: "inattentive_driving", severity: 5 },
        { type: "harsh_braking", severity: 5 },
      ],
      hosHours: 100, weatherRisk: 10, zoneRisk: 10, speed: 90, // weatherRisk/zoneRisk outside the documented 0–1 domain
    });
    assert.equal(result.contextualSpeed.multiplier, 2.5); // MULTIPLIER_CAP, unchanged
    assert.equal(result.contextualSpeed.finalPenalty, result.contextualSpeed.speedExposure * 2.5);
  });

  test("15. final score remains clamped between 0 and 100 under an extreme combined scenario", () => {
    const result = calculateRisk({
      safetyEvents: [
        { type: "speeding", severity: 5 },
        { type: "speeding", severity: 5 },
        { type: "harsh_braking", severity: 5 },
        { type: "mobile_usage", severity: 5 },
        { type: "high_speed_power_loss", severity: 5 },
      ],
      hosHours: 20, weatherRisk: 1, zoneRisk: 1, speed: 150, // beyond the clamp
    });
    assert.ok(result.score >= 0 && result.score <= 100);
  });

  test("16. existing speeding-event penalties continue working, independent of continuous exposure", () => {
    const result = calculateRisk({ ...low, speed: 0, safetyEvents: [{ type: "speeding", severity: 4 }] });
    assert.equal(result.contextualSpeed.active, false); // no continuous exposure at 0mph
    assert.ok(result.factors.some((f) => f.name === "Speeding")); // but the standalone event penalty still fires
    assert.ok(result.score < 100);
  });

  test("17. no unintended double-counting: a standalone speeding event does not amplify continuous speed exposure", () => {
    const withoutEvent = calculateRisk({ ...low, speed: 65 }).contextualSpeed;
    const withSpeedingEvent = calculateRisk({ ...low, speed: 65, safetyEvents: [{ type: "speeding", severity: 5 }] }).contextualSpeed;
    assert.equal(withSpeedingEvent.multiplier, withoutEvent.multiplier); // "speeding" is excluded from the behavior modifier
    const behaviorComponent = withSpeedingEvent.components.find((c) => c.key === "behavior")!;
    assert.equal(behaviorComponent.modifier, 0);

    // harsh_braking, by contrast, IS eligible to amplify (behaviorally independent of current speed).
    const withHarshBraking = calculateRisk({ ...low, speed: 65, safetyEvents: [{ type: "harsh_braking", severity: 5 }] }).contextualSpeed;
    assert.ok(withHarshBraking.multiplier > withoutEvent.multiplier);
  });

  test("18. explainability components sum consistently with the final contextual penalty", () => {
    const result = calculateRisk({
      safetyEvents: [{ type: "harsh_turn", severity: 2 }],
      hosHours: 11, weatherRisk: 0.6, zoneRisk: 0.4, speed: 95,
    });
    const { speedExposure, multiplier, finalPenalty, components } = result.contextualSpeed;
    const impliedMultiplier = Math.min(1 + components.reduce((sum, c) => sum + c.modifier, 0), 2.5);
    assert.ok(Math.abs(multiplier - impliedMultiplier) < 1e-9);
    assert.ok(Math.abs(finalPenalty - speedExposure * multiplier) < 1e-9);
  });

  test("19. existing non-speed risk calculations remain stable", () => {
    const result = calculateRisk({
      safetyEvents: [{ type: "harsh_braking", severity: 3 }],
      hosHours: null, weatherRisk: 0, zoneRisk: 0, speed: 0,
    });
    assert.equal(result.contextualSpeed.active, false);
    assert.ok(result.factors.some((f) => f.name === "Harsh Braking"));
    assert.ok(!result.factors.some((f) => f.name === "Fatigue"));
  });

  test("missingContext never includes 'behavior' (always structurally available, no *Available flag needed)", () => {
    const result = calculateRisk({
      ...low, speed: 90, weatherAvailable: false, zoneRiskAvailable: false, hosAvailable: false,
    });
    assert.deepEqual(result.contextualSpeed.missingContext, ["Weather", "Zone risk", "HOS"]);
    const behaviorComponent = result.contextualSpeed.components.find((c) => c.key === "behavior")!;
    assert.equal(behaviorComponent.included, true);
  });
});

// ---------------------------------------------------------------------------
// Phase 6A (2026-08-xx) — following_distance / rolling_stop scoring.
//
// Both event types were already flowing through real ingestion (9 real
// following_distance, 2 real rolling_stop events for the pilot fleet) but
// had no case in calcSafetyEventPenalties — they were stored and visible
// in the Audit trail but contributed zero to the score. This section pins
// down: weight (1.5 each, tied with the lowest existing tier), the
// temporary 3-event pilot-safeguard cap (identical for both types, NOT a
// statistically validated threshold — see the constant's own doc comment
// in riskEngine.ts), following_distance's (but not rolling_stop's)
// membership in BEHAVIOR_RELEVANT_EVENT_TYPES, factor labels, and
// recommendation triggers.
//
// `low` fixture speed:0 keeps Contextual Speed's finalPenalty at exactly 0
// (see "1. zero speed produces zero exposure" above), which isolates the
// direct calcSafetyEventPenalties contribution for clean, hand-verifiable
// arithmetic in the weight/cap tests below. A separate describe block
// further down uses a nonzero speed specifically to demonstrate the
// BEHAVIOR_RELEVANT_EVENT_TYPES amplification difference between the two
// types, which speed:0 would otherwise hide (0 exposure × any multiplier
// is still 0).
// ---------------------------------------------------------------------------

describe("calculateRisk — Phase 6A: following_distance / rolling_stop weight + cap", () => {
  const low = { weatherRisk: 0, zoneRisk: 0, hosHours: 4, speed: 0 };

  function eventsOf(type: string, count: number, severity = 3) {
    return Array.from({ length: count }, () => ({ type, severity }));
  }

  describe("following_distance", () => {
    test("1 event (severity 3): penalty = 1.5 * 3 = 4.5, score 96", () => {
      const result = calculateRisk({ ...low, safetyEvents: eventsOf("following_distance", 1) });
      assert.equal(result.score, 96);
      assert.deepEqual(result.factors, [{ name: "Following Distance", impact: 100 }]);
    });

    test("2 events: penalty = 2 * 4.5 = 9, score 91", () => {
      const result = calculateRisk({ ...low, safetyEvents: eventsOf("following_distance", 2) });
      assert.equal(result.score, 91);
    });

    test("3 events (at the cap): penalty = 3 * 4.5 = 13.5, score 87", () => {
      const result = calculateRisk({ ...low, safetyEvents: eventsOf("following_distance", 3) });
      assert.equal(result.score, 87);
    });

    test("4 events (over the cap): score UNCHANGED from 3 — the 4th event adds nothing to the score", () => {
      const at3 = calculateRisk({ ...low, safetyEvents: eventsOf("following_distance", 3) });
      const at4 = calculateRisk({ ...low, safetyEvents: eventsOf("following_distance", 4) });
      assert.equal(at4.score, at3.score);
      assert.equal(at4.score, 87);
    });

    test("10 events: still capped at exactly the 3-event penalty, never grows further", () => {
      const at3 = calculateRisk({ ...low, safetyEvents: eventsOf("following_distance", 3) });
      const at10 = calculateRisk({ ...low, safetyEvents: eventsOf("following_distance", 10) });
      assert.equal(at10.score, at3.score);
    });

    test("triggers the (existing, reused) following-distance recommendation and no other new one", () => {
      const result = calculateRisk({ ...low, safetyEvents: eventsOf("following_distance", 1) });
      assert.ok(result.recommendations.includes("Reduce speed and maintain a safe following distance."));
      assert.ok(!result.recommendations.includes("Come to a complete stop at stop signs and red lights."));
    });
  });

  describe("rolling_stop", () => {
    test("1 event (severity 3): penalty = 1.5 * 3 = 4.5, score 96", () => {
      const result = calculateRisk({ ...low, safetyEvents: eventsOf("rolling_stop", 1) });
      assert.equal(result.score, 96);
      assert.deepEqual(result.factors, [{ name: "Rolling Stop", impact: 100 }]);
    });

    test("2 events: penalty = 2 * 4.5 = 9, score 91", () => {
      const result = calculateRisk({ ...low, safetyEvents: eventsOf("rolling_stop", 2) });
      assert.equal(result.score, 91);
    });

    test("3 events (at the cap): penalty = 3 * 4.5 = 13.5, score 87", () => {
      const result = calculateRisk({ ...low, safetyEvents: eventsOf("rolling_stop", 3) });
      assert.equal(result.score, 87);
    });

    test("4 events (over the cap): score UNCHANGED from 3 — the temporary pilot-safeguard cap applies identically to rolling_stop", () => {
      const at3 = calculateRisk({ ...low, safetyEvents: eventsOf("rolling_stop", 3) });
      const at4 = calculateRisk({ ...low, safetyEvents: eventsOf("rolling_stop", 4) });
      assert.equal(at4.score, at3.score);
      assert.equal(at4.score, 87);
    });

    test("10 events: still capped at exactly the 3-event penalty", () => {
      const at3 = calculateRisk({ ...low, safetyEvents: eventsOf("rolling_stop", 3) });
      const at10 = calculateRisk({ ...low, safetyEvents: eventsOf("rolling_stop", 10) });
      assert.equal(at10.score, at3.score);
    });

    test("triggers the new Traffic Control recommendation and no other new one", () => {
      const result = calculateRisk({ ...low, safetyEvents: eventsOf("rolling_stop", 1) });
      assert.ok(result.recommendations.includes("Come to a complete stop at stop signs and red lights."));
      assert.ok(!result.recommendations.includes("Reduce speed and maintain a safe following distance."));
    });
  });

  test("the two caps are independent — 3 of each simultaneously still scores as the sum of both individual 3-event penalties", () => {
    const result = calculateRisk({
      ...low,
      safetyEvents: [...eventsOf("following_distance", 5), ...eventsOf("rolling_stop", 5)],
    });
    // 13.5 (following_distance, capped at 3) + 13.5 (rolling_stop, capped at 3) = 27
    assert.equal(result.score, 73);
    assert.ok(result.factors.some((f) => f.name === "Following Distance"));
    assert.ok(result.factors.some((f) => f.name === "Rolling Stop"));
  });

  test("cap is purely a scoring concept — calculateRisk never mutates or drops events from its input (storage/Audit-trail/event-count are populated upstream from the same unmodified array, never from this engine)", () => {
    const events = eventsOf("following_distance", 5);
    const snapshotLength = events.length;
    calculateRisk({ ...low, safetyEvents: events });
    assert.equal(events.length, snapshotLength, "calculateRisk must not mutate the input events array");
  });

  test("existing event types are completely unaffected by this phase (harsh_braking weight/behavior unchanged)", () => {
    const result = calculateRisk({ ...low, safetyEvents: [{ type: "harsh_braking", severity: 3 }] });
    assert.equal(result.score, 94); // 2 * 3 = 6 penalty, unchanged from before this phase
    assert.deepEqual(result.factors, [{ name: "Harsh Braking", impact: 100 }]);
  });
});

describe("calculateRisk — Phase 6A: BEHAVIOR_RELEVANT_EVENT_TYPES membership", () => {
  const low = { weatherRisk: 0, zoneRisk: 0, hosHours: 4, speed: 65 };

  test("following_distance amplifies Contextual Speed (included in BEHAVIOR_RELEVANT_EVENT_TYPES)", () => {
    const baseline = calculateRisk({ ...low, safetyEvents: [] }).contextualSpeed;
    const withEvent = calculateRisk({ ...low, safetyEvents: [{ type: "following_distance", severity: 3 }] }).contextualSpeed;
    assert.equal(baseline.multiplier, 1);
    assert.ok(withEvent.multiplier > 1, "following_distance must amplify the Contextual Speed multiplier");
    const behaviorComponent = withEvent.components.find((c) => c.key === "behavior")!;
    assert.ok(behaviorComponent.modifier > 0);
  });

  test("rolling_stop does NOT amplify Contextual Speed (excluded from BEHAVIOR_RELEVANT_EVENT_TYPES)", () => {
    const baseline = calculateRisk({ ...low, safetyEvents: [] }).contextualSpeed;
    const withEvent = calculateRisk({ ...low, safetyEvents: [{ type: "rolling_stop", severity: 3 }] }).contextualSpeed;
    assert.equal(withEvent.multiplier, baseline.multiplier);
    const behaviorComponent = withEvent.components.find((c) => c.key === "behavior")!;
    assert.equal(behaviorComponent.modifier, 0);
  });

  test("at otherwise-identical inputs, a following_distance event produces a strictly lower score than an equivalent rolling_stop event, due solely to the Contextual Speed amplification difference", () => {
    const withFollowingDistance = calculateRisk({ ...low, safetyEvents: [{ type: "following_distance", severity: 3 }] });
    const withRollingStop = calculateRisk({ ...low, safetyEvents: [{ type: "rolling_stop", severity: 3 }] });
    // Both have an identical direct penalty (1.5 * 3 = 4.5) — the only
    // difference is following_distance's extra Contextual Speed contribution.
    assert.equal(withFollowingDistance.score, 91);
    assert.equal(withRollingStop.score, 92);
    assert.ok(withFollowingDistance.score < withRollingStop.score);
  });
});

// ---------------------------------------------------------------------------
// "crash" (2026-08-xx) — a real Samsara Crash event (2026-08-07, pilot
// driver Rushana) was fetched and stored but silently dropped at
// normalization because SAMSARA_TYPE_MAP had no entry for it (see
// lib/providers/samsara/__tests__/normalizeStreamEvent.test.ts for that
// fix). This section proves the OTHER half of the fix: now that "crash"
// normalizes and persists as a DriverEvent, it must NOT start silently
// contributing to the predictive risk score — a crash is an observed
// outcome, not (yet) a scored precursor. calcSafetyEventPenalties's switch
// has an explicit no-op `case "crash": break;` (see riskEngine.ts) rather
// than relying on the absence of a case, specifically so this is a
// documented decision, not an accidental gap — these tests pin that
// decision down as a regression guard.
// ---------------------------------------------------------------------------

describe("calculateRisk — 'crash' is persisted-safe but intentionally unscored", () => {
  const low = { weatherRisk: 0, zoneRisk: 0, hosHours: 4, speed: 0 };

  test("a lone crash event does not change the score at all, at any severity", () => {
    for (const severity of [1, 2, 3, 4, 5]) {
      const result = calculateRisk({ ...low, safetyEvents: [{ type: "crash", severity }] });
      assert.equal(result.score, 100, `severity ${severity} must not affect the score`);
    }
  });

  test("a crash event never appears in result.factors — there is no scored bucket for it", () => {
    const result = calculateRisk({ ...low, safetyEvents: [{ type: "crash", severity: 5 }] });
    assert.deepEqual(result.factors, []);
  });

  test("multiple crash events (even many) still contribute nothing — no cap needed because there is nothing to accumulate", () => {
    const events = Array.from({ length: 10 }, () => ({ type: "crash", severity: 5 }));
    const result = calculateRisk({ ...low, safetyEvents: events });
    assert.equal(result.score, 100);
  });

  test("crash does not amplify Contextual Speed — not a member of BEHAVIOR_RELEVANT_EVENT_TYPES", () => {
    const withSpeed = { weatherRisk: 0, zoneRisk: 0, hosHours: 4, speed: 65 };
    const baseline = calculateRisk({ ...withSpeed, safetyEvents: [] }).contextualSpeed;
    const withCrash = calculateRisk({ ...withSpeed, safetyEvents: [{ type: "crash", severity: 5 }] }).contextualSpeed;
    assert.equal(withCrash.multiplier, baseline.multiplier);
    assert.equal(withCrash.finalPenalty, baseline.finalPenalty);
  });

  test("a crash alongside other real safety events: only the other events score, crash contributes exactly zero (no interference either direction)", () => {
    const withoutCrash = calculateRisk({
      ...low,
      safetyEvents: [{ type: "harsh_braking", severity: 3 }],
    });
    const withCrash = calculateRisk({
      ...low,
      safetyEvents: [{ type: "harsh_braking", severity: 3 }, { type: "crash", severity: 5 }],
    });
    assert.equal(withCrash.score, withoutCrash.score);
    assert.deepEqual(withCrash.factors, withoutCrash.factors);
  });

  test("no recommendation is triggered by a crash event alone (no existing recommendation condition reads a crash-specific penalty, since none exists)", () => {
    const result = calculateRisk({ ...low, safetyEvents: [{ type: "crash", severity: 5 }] });
    assert.deepEqual(result.recommendations, []);
  });
});

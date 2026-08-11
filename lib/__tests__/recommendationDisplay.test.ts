import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyRecommendation } from "../recommendationDisplay";

describe("classifyRecommendation", () => {
  test("fatigue", () => {
    assert.deepEqual(classifyRecommendation("Consider a rest break soon."), { category: "fatigue", title: "Fatigue" });
  });

  test("weather", () => {
    assert.deepEqual(
      classifyRecommendation("Use extra caution due to current weather conditions."),
      { category: "weather", title: "Weather" }
    );
  });

  test("speed (including the following-distance-worded message, unchanged from before Phase 6A)", () => {
    assert.deepEqual(
      classifyRecommendation("Reduce speed and maintain a safe following distance."),
      { category: "speed", title: "Speed" }
    );
  });

  test("zone alert", () => {
    assert.deepEqual(
      classifyRecommendation("Proceed carefully in the current risk zone."),
      { category: "zoneAlert", title: "Zone Alert" }
    );
  });

  test("distraction", () => {
    assert.deepEqual(
      classifyRecommendation("Put the phone away — distracted driving is a leading cause of crashes."),
      { category: "distraction", title: "Distraction" }
    );
  });

  test("braking — a message with 'brake'/'stop' and no earlier-matching keyword", () => {
    assert.deepEqual(
      classifyRecommendation("Brake earlier next time."),
      { category: "braking", title: "Braking" }
    );
  });

  test("vehicle — a pull-over/inspect message without an earlier-matching keyword", () => {
    assert.deepEqual(
      classifyRecommendation("Pull over safely and inspect the vehicle."),
      { category: "vehicle", title: "Vehicle" }
    );
  });

  test("driving style", () => {
    assert.deepEqual(
      classifyRecommendation("Smooth acceleration and turns improve safety and fuel efficiency."),
      { category: "drivingStyle", title: "Driving Style" }
    );
  });

  test("advisory (fallback for anything unmatched)", () => {
    assert.deepEqual(classifyRecommendation("Something entirely unrelated."), { category: "advisory", title: "Advisory" });
  });

  // Phase 6A (2026-08-xx) — the actual regression this file exists to protect.
  describe("Traffic Control (Phase 6A rolling-stop recommendation)", () => {
    test("the exact rolling-stop recommendation string classifies as Traffic Control, not Braking", () => {
      assert.deepEqual(
        classifyRecommendation("Come to a complete stop at stop signs and red lights."),
        { category: "trafficControl", title: "Traffic Control" }
      );
    });

    test("would have matched the generic braking branch were ordering wrong — confirms 'stop sign' is checked first", () => {
      // Sanity check on the fixture itself: this string DOES contain "stop"
      // (the substring the generic braking branch matches on), so this test
      // only passes if the more specific "stop sign" branch is evaluated
      // before the generic "brake"/"stop" branch.
      const rec = "Come to a complete stop at stop signs and red lights.";
      assert.ok(rec.toLowerCase().includes("stop"), "fixture sanity check");
      assert.equal(classifyRecommendation(rec).category, "trafficControl");
    });

    test("'red light' alone also classifies as Traffic Control", () => {
      assert.equal(classifyRecommendation("Watch for the red light ahead.").category, "trafficControl");
    });

    test("a genuine braking message without 'stop sign'/'red light' still classifies as Braking, unaffected", () => {
      assert.equal(classifyRecommendation("Brake earlier next time.").category, "braking");
      assert.equal(classifyRecommendation("Please stop tailgating.").category, "braking");
    });
  });

  // Fix (same Phase 6A pass): these two messages previously fell into the
  // generic "Speed" bucket because they happen to contain "speed"-branch
  // substrings ("stop" / "speed") — discovered while writing the Phase 6A
  // tests above, pre-existing and unrelated to the following_distance/
  // rolling_stop scoring change itself. trafficControl/braking/vehicle are
  // now checked before the generic "speed" branch (see the file header).
  describe("pre-existing Speed-bucket misclassification fix", () => {
    test("the harsh-braking recommendation now classifies as Braking, not Speed", () => {
      assert.deepEqual(
        classifyRecommendation("Increase following distance to avoid sudden stops."),
        { category: "braking", title: "Braking" }
      );
    });

    test("the mechanical-risk recommendation now classifies as Vehicle, not Speed", () => {
      assert.deepEqual(
        classifyRecommendation("High-speed power loss detected — pull over safely and inspect the vehicle."),
        { category: "vehicle", title: "Vehicle" }
      );
    });

    test("the shared speed/following-distance recommendation is unaffected — still classifies as Speed", () => {
      assert.deepEqual(
        classifyRecommendation("Reduce speed and maintain a safe following distance."),
        { category: "speed", title: "Speed" }
      );
    });

    test("every other existing classification is unaffected by the reordering", () => {
      assert.equal(classifyRecommendation("Consider a rest break soon.").category, "fatigue");
      assert.equal(classifyRecommendation("Use extra caution due to current weather conditions.").category, "weather");
      assert.equal(classifyRecommendation("Proceed carefully in the current risk zone.").category, "zoneAlert");
      assert.equal(classifyRecommendation("Put the phone away — distracted driving is a leading cause of crashes.").category, "distraction");
      assert.equal(classifyRecommendation("Smooth acceleration and turns improve safety and fuel efficiency.").category, "drivingStyle");
      assert.equal(classifyRecommendation("Come to a complete stop at stop signs and red lights.").category, "trafficControl");
      assert.equal(classifyRecommendation("Something entirely unrelated.").category, "advisory");
    });
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyHistoricalSampleQuality, extractContextSources } from "../historicalSamples";

// Fixtures mirror the real persisted breakdownJson shape:
// { factors: [...], contextSources: { <field>: {origin, state, provider, observedAt} } }
const OBSERVED_FRESH = { origin: "observed", state: "fresh", provider: "samsara", observedAt: "2026-09-25T13:00:00.000Z" };
const OBSERVED_FRESH_WEATHER = { origin: "observed", state: "fresh", provider: "openweather", observedAt: "2026-09-25T13:00:00.000Z" };
const UNAVAILABLE = { origin: null, state: "unavailable", provider: null, observedAt: null };
const SIMULATED_FRESH = { origin: "simulated", state: "fresh", provider: "internal", observedAt: "2026-09-25T13:00:00.000Z" };

function breakdown(sources: Record<string, unknown>) {
  return { factors: [], contextSources: sources };
}

/** The real pilot shape today: live GPS/speed/weather/zone, HOS dead fleet-wide. */
const RICH = breakdown({
  safetyEvents: OBSERVED_FRESH,
  hos: UNAVAILABLE,
  speed: OBSERVED_FRESH,
  weather: OBSERVED_FRESH_WEATHER,
  zoneRisk: OBSERVED_FRESH,
  location: OBSERVED_FRESH,
});

/** The real "no vehicle resolvable" shape: only the events check was live. */
const POSITIONLESS = breakdown({
  safetyEvents: OBSERVED_FRESH,
  hos: UNAVAILABLE,
  speed: UNAVAILABLE,
  weather: UNAVAILABLE,
  zoneRisk: UNAVAILABLE,
  location: UNAVAILABLE,
});

describe("classifyHistoricalSampleQuality — historical rows written before the fix", () => {
  test("a rich historical sample is usable and recomputes to partial_live", () => {
    const r = classifyHistoricalSampleQuality(RICH);
    assert.equal(r.usable, true);
    assert.equal(r.contextStatus, "partial_live");
    // 5 of 6 is the realistic ceiling while HOS is unavailable fleet-wide.
    assert.deepEqual(r.dataCompleteness, { count: 5, total: 6 });
  });

  test("an empty/positionless historical sample is NOT usable, even though the row stored partial_live", () => {
    const r = classifyHistoricalSampleQuality(POSITIONLESS);
    assert.equal(r.usable, false);
    assert.equal(r.contextStatus, "insufficient_context");
    assert.deepEqual(r.dataCompleteness, { count: 1, total: 6 });
  });

  test("HOS unavailable ALONE never invalidates a sample", () => {
    // Identical to RICH, which already has hos: UNAVAILABLE.
    const r = classifyHistoricalSampleQuality(RICH);
    assert.equal(r.usable, true);
    assert.notEqual(r.contextStatus, "insufficient_context");
  });

  test("genuine zero readings are live data, not missing data", () => {
    // A stopped truck outside every curated zone in clear weather legitimately
    // reports speed 0 / zoneRisk 0 / weatherRisk 0 — provenance is what counts,
    // never the value, so this must stay usable.
    const r = classifyHistoricalSampleQuality(RICH);
    assert.equal(r.usable, true);
    assert.equal(r.dataCompleteness!.count, 5);
  });

  test("one live positional field is enough to keep a sample usable", () => {
    const r = classifyHistoricalSampleQuality(
      breakdown({
        safetyEvents: OBSERVED_FRESH,
        hos: UNAVAILABLE,
        speed: OBSERVED_FRESH,
        weather: UNAVAILABLE,
        zoneRisk: UNAVAILABLE,
        location: OBSERVED_FRESH,
      })
    );
    assert.equal(r.usable, true);
    assert.equal(r.contextStatus, "partial_live");
  });

  test("a demo-era sample classifies as demo, not insufficient", () => {
    const r = classifyHistoricalSampleQuality(
      breakdown({
        safetyEvents: SIMULATED_FRESH,
        hos: SIMULATED_FRESH,
        speed: SIMULATED_FRESH,
        weather: SIMULATED_FRESH,
        zoneRisk: SIMULATED_FRESH,
        location: SIMULATED_FRESH,
      })
    );
    assert.equal(r.contextStatus, "demo");
  });

  test("a fully live sample (hypothetical: HOS restored) recomputes to full_live, 6 of 6", () => {
    const r = classifyHistoricalSampleQuality(
      breakdown({
        safetyEvents: OBSERVED_FRESH,
        hos: OBSERVED_FRESH,
        speed: OBSERVED_FRESH,
        weather: OBSERVED_FRESH_WEATHER,
        zoneRisk: OBSERVED_FRESH,
        location: OBSERVED_FRESH,
      })
    );
    assert.equal(r.contextStatus, "full_live");
    assert.deepEqual(r.dataCompleteness, { count: 6, total: 6 });
  });
});

describe("classifyHistoricalSampleQuality — defensive parsing (breakdownJson is an unvalidated Json column)", () => {
  test("null / non-object breakdownJson is unclassifiable and therefore NOT usable", () => {
    for (const bad of [null, undefined, 42, "nope", []]) {
      const r = classifyHistoricalSampleQuality(bad);
      assert.equal(r.usable, false);
      assert.equal(r.contextStatus, null);
      assert.equal((r as { reason?: string }).reason, "no_context_sources");
    }
  });

  test("breakdownJson with no contextSources key is unclassifiable", () => {
    const r = classifyHistoricalSampleQuality({ factors: [] });
    assert.equal(r.usable, false);
    assert.equal((r as { reason?: string }).reason, "no_context_sources");
  });

  test("contextSources missing a required field is unclassifiable rather than silently scored", () => {
    const r = classifyHistoricalSampleQuality(
      breakdown({
        safetyEvents: OBSERVED_FRESH,
        hos: UNAVAILABLE,
        speed: OBSERVED_FRESH,
        weather: OBSERVED_FRESH_WEATHER,
        zoneRisk: OBSERVED_FRESH,
        // location absent
      })
    );
    assert.equal(r.usable, false);
    assert.equal((r as { reason?: string }).reason, "no_context_sources");
  });

  test("extractContextSources returns the sources object when well-formed", () => {
    assert.ok(extractContextSources(RICH));
    assert.equal(extractContextSources({ factors: [] }), null);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { roundWeatherCoordinate, parseWeatherResponse } from "../samsara";

// Phase 2 — Weather from Real Vehicle GPS. parseWeatherResponse/
// roundWeatherCoordinate are the pure, easily-isolated pieces of the
// refactored weather provider; the fetch wrapper itself (getWeatherRiskField)
// follows the same untested-at-the-HTTP-layer precedent already established
// for fetchSamsaraHosClocks/fetchVehicleStatsHistoryPage — only its pure
// parse function is unit tested.

describe("roundWeatherCoordinate", () => {
  test("rounds to 2 decimal places", () => {
    assert.equal(roundWeatherCoordinate(35.078091), 35.08);
    assert.equal(roundWeatherCoordinate(-81.721605), -81.72);
  });

  test("does not swap or otherwise mix latitude/longitude — pure per-value rounding", () => {
    const lat = roundWeatherCoordinate(34.944691);
    const lon = roundWeatherCoordinate(-82.072264);
    assert.equal(lat, 34.94);
    assert.equal(lon, -82.07);
    assert.notEqual(lat, lon);
  });

  test("already-coarse coordinates are unchanged", () => {
    assert.equal(roundWeatherCoordinate(33.75), 33.75);
  });
});

describe("parseWeatherResponse", () => {
  function response(overrides: Record<string, unknown> = {}) {
    return {
      dt: 1753147200, // 2025-07-22T01:20:00.000Z
      weather: [{ id: 800, description: "clear sky" }],
      wind: { speed: 0 },
      visibility: 10000,
      ...overrides,
    };
  }

  test("valid response: converts dt to ISO 8601, preserves risk calculation, carries condition summary", () => {
    const result = parseWeatherResponse(response());
    assert.deepEqual(result, {
      weatherRisk: 0, // condition 800 exactly hits neither the <800 nor >800 band; no wind/visibility contribution
      observedAt: "2025-07-22T01:20:00.000Z",
      conditionSummary: "clear sky",
    });
  });

  test("thunderstorm condition + wind + poor visibility all contribute to weatherRisk (calculation preserved)", () => {
    const result = parseWeatherResponse(
      response({
        weather: [{ id: 200, description: "thunderstorm with light rain" }],
        wind: { speed: 20 }, // caps the wind contribution at 0.30
        visibility: 0, // caps the visibility contribution at 0.20
      })
    );
    // 0.50 (2xx band) + 0.30 (wind cap) + 0.20 (visibility cap) = 1.00, clamped to 1
    assert.equal(result?.weatherRisk, 1);
  });

  test("missing dt -> null, never a fabricated timestamp", () => {
    const result = parseWeatherResponse(response({ dt: undefined }));
    assert.equal(result, null);
  });

  test("malformed dt (string, not a number) -> null", () => {
    const result = parseWeatherResponse(response({ dt: "not-a-number" }));
    assert.equal(result, null);
  });

  test("non-finite dt (NaN) -> null", () => {
    const result = parseWeatherResponse(response({ dt: NaN }));
    assert.equal(result, null);
  });

  test("missing weather[0].description -> conditionSummary null, rest still valid", () => {
    const result = parseWeatherResponse(response({ weather: [{ id: 800 }] }));
    assert.equal(result?.conditionSummary, null);
    assert.equal(result?.observedAt, "2025-07-22T01:20:00.000Z");
  });

  test("malformed response (missing weather/wind/visibility entirely) still parses via weatherDataToRisk's defaults", () => {
    const result = parseWeatherResponse({ dt: 1753147200 });
    assert.equal(result?.weatherRisk, 0);
    assert.equal(result?.conditionSummary, null);
  });

  test("null/undefined input -> null, not a crash", () => {
    assert.equal(parseWeatherResponse(null), null);
    assert.equal(parseWeatherResponse(undefined), null);
  });
});

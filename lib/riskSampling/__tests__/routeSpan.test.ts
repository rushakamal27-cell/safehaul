import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveRouteSpan, MOVEMENT_SPEED_THRESHOLD_MPH, type ObservationForRouteSpan } from "../routeSpan";

function obs(partial: Partial<ObservationForRouteSpan> & { observedAt: Date }): ObservationForRouteSpan {
  return {
    latitude: null,
    longitude: null,
    speedMph: null,
    locationLabel: null,
    ...partial,
  };
}

describe("deriveRouteSpan", () => {
  test("earliest qualifying (moving) observation becomes start, latest becomes end", () => {
    const result = deriveRouteSpan([
      obs({ observedAt: new Date("2026-08-22T12:00:00Z"), latitude: 40, longitude: -75, speedMph: 55, locationLabel: "Philadelphia, PA" }),
      obs({ observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: 55, locationLabel: "Baltimore, MD" }),
      obs({ observedAt: new Date("2026-08-22T18:00:00Z"), latitude: 41, longitude: -87, speedMph: 55, locationLabel: "LaPorte County, IN" }),
    ]);
    assert.equal(result.available, true);
    assert.equal(result.start?.locationLabel, "Baltimore, MD");
    assert.equal(result.end?.locationLabel, "LaPorte County, IN");
  });

  test("stationary observations (below the movement threshold) do not become endpoints when a moving reading exists", () => {
    const result = deriveRouteSpan([
      obs({ observedAt: new Date("2026-08-22T05:00:00Z"), latitude: 39, longitude: -76, speedMph: 0, locationLabel: "Parked overnight" }),
      obs({ observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: 55, locationLabel: "Baltimore, MD" }),
      obs({ observedAt: new Date("2026-08-22T18:00:00Z"), latitude: 41, longitude: -87, speedMph: 55, locationLabel: "LaPorte County, IN" }),
      obs({ observedAt: new Date("2026-08-22T22:00:00Z"), latitude: 41, longitude: -87, speedMph: 0, locationLabel: "Parked for the night" }),
    ]);
    assert.equal(result.start?.locationLabel, "Baltimore, MD");
    assert.equal(result.end?.locationLabel, "LaPorte County, IN");
  });

  test("a reading exactly at the movement threshold counts as moving", () => {
    const result = deriveRouteSpan([
      obs({ observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: MOVEMENT_SPEED_THRESHOLD_MPH, locationLabel: "Threshold" }),
    ]);
    assert.equal(result.available, true);
    assert.equal(result.start?.locationLabel, "Threshold");
  });

  test("no-movement day: falls back to earliest/latest fresh-GPS observations when nothing qualifies as moving", () => {
    const result = deriveRouteSpan([
      obs({ observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: 0, locationLabel: "Depot" }),
      obs({ observedAt: new Date("2026-08-22T18:00:00Z"), latitude: 39, longitude: -76, speedMph: 1, locationLabel: "Depot" }),
    ]);
    assert.equal(result.available, true);
    assert.equal(result.start?.locationLabel, "Depot");
  });

  test("no defensible observation at all: available is false, start and end are both null", () => {
    const result = deriveRouteSpan([]);
    assert.equal(result.available, false);
    assert.equal(result.start, null);
    assert.equal(result.end, null);
  });

  test("observations with no coordinates at all are excluded even from the fallback pool", () => {
    const result = deriveRouteSpan([
      obs({ observedAt: new Date("2026-08-22T06:00:00Z"), latitude: null, longitude: null, speedMph: 55 }),
    ]);
    assert.equal(result.available, false);
  });

  test("a single qualifying observation is both start and end", () => {
    const result = deriveRouteSpan([
      obs({ observedAt: new Date("2026-08-22T06:00:00Z"), latitude: 39, longitude: -76, speedMph: 55, locationLabel: "Baltimore, MD" }),
    ]);
    assert.equal(result.start?.locationLabel, "Baltimore, MD");
    assert.equal(result.end?.locationLabel, "Baltimore, MD");
  });
});

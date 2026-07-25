import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { haversineDistanceMiles, matchZone } from "../zoneRisk";
import type { ZoneDefinition } from "../zoneData";

describe("haversineDistanceMiles", () => {
  test("distance from a point to itself is 0", () => {
    assert.equal(haversineDistanceMiles(35.0, -81.0, 35.0, -81.0), 0);
  });

  test("known distance: roughly 1 degree of longitude at the equator is ~69 miles", () => {
    const miles = haversineDistanceMiles(0, 0, 0, 1);
    assert.ok(miles > 68 && miles < 70, `expected ~69 miles, got ${miles}`);
  });
});

describe("matchZone", () => {
  const ZONES: ZoneDefinition[] = [
    { id: "a", name: "Zone A", latitude: 35.0, longitude: -81.0, radiusMiles: 10, riskScore: 0.5 },
    { id: "b", name: "Zone B", latitude: 35.05, longitude: -81.0, radiusMiles: 10, riskScore: 0.8 },
    { id: "c", name: "Zone C", latitude: 40.0, longitude: -90.0, radiusMiles: 5, riskScore: 0.3 },
  ];

  test("exact center of a zone matches that zone at distance 0", () => {
    const match = matchZone(35.0, -81.0, ZONES);
    assert.equal(match?.zone.id, "a");
    assert.equal(match?.distanceMiles, 0);
  });

  test("point outside every zone's radius returns null", () => {
    const match = matchZone(0, 0, ZONES);
    assert.equal(match, null);
  });

  test("point inside overlapping zones' radii matches the nearer zone, not the first in the list", () => {
    // Roughly 2 miles north of Zone A's center, well within both A's and B's 10mi radius,
    // but closer to A (0 lat offset) than B (0.05 lat offset, ~3.5mi away).
    const match = matchZone(35.02, -81.0, ZONES);
    assert.equal(match?.zone.id, "a");
  });

  test("a point closer to zone B than zone A matches B even though A is listed first", () => {
    const match = matchZone(35.049, -81.0, ZONES);
    assert.equal(match?.zone.id, "b");
  });

  test("point exactly at a zone's radius boundary matches (inclusive)", () => {
    // 1 degree of latitude is ~69 miles; use a zone sized so the boundary is easy to hit precisely via distance calculation itself.
    const boundaryZones: ZoneDefinition[] = [
      { id: "boundary", name: "Boundary Zone", latitude: 0, longitude: 0, radiusMiles: 69.09, riskScore: 0.5 },
    ];
    const distance = haversineDistanceMiles(0, 0, 1, 0);
    const zones = [{ ...boundaryZones[0], radiusMiles: distance }];
    const match = matchZone(1, 0, zones);
    assert.ok(match, "point exactly at the radius boundary must match (inclusive)");
    assert.equal(match?.zone.id, "boundary");
  });

  test("point just past a zone's radius boundary does not match", () => {
    const distance = haversineDistanceMiles(0, 0, 1, 0);
    const zones: ZoneDefinition[] = [
      { id: "boundary", name: "Boundary Zone", latitude: 0, longitude: 0, radiusMiles: distance - 0.001, riskScore: 0.5 },
    ];
    const match = matchZone(1, 0, zones);
    assert.equal(match, null);
  });

  test("empty zone list returns null, not a crash", () => {
    assert.equal(matchZone(35.0, -81.0, []), null);
  });

  test("defaults to the real ZONE_DATA dataset when no zones argument is passed", () => {
    // Port of Houston Ship Channel's own center coordinates must match against the real dataset.
    const match = matchZone(29.7355, -95.0895);
    assert.equal(match?.zone.id, "port-houston-ship-channel");
  });
});

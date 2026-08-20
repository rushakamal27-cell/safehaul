import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildComplianceScoreAuditItem, buildTripAuditItem } from "../auditItems";

describe("buildComplianceScoreAuditItem", () => {
  test("title is 'Daily Safety Score', not 'Daily Compliance Score'", () => {
    const { event } = buildComplianceScoreAuditItem({
      id: "cs_1", score: 99, dangerLevel: "LOW", updatedAt: new Date("2026-08-20T14:36:07.299Z"),
    });
    assert.equal(event.title, "Daily Safety Score");
  });

  test("displayed timestamp is the row's updatedAt (latest included calculation), not midnight", () => {
    const updatedAt = new Date("2026-08-20T14:36:07.299Z");
    const { ts, event } = buildComplianceScoreAuditItem({
      id: "cs_1", score: 99, dangerLevel: "LOW", updatedAt,
    });
    assert.equal(ts, updatedAt);
    assert.match(event.date, /2:36 PM UTC/);
    assert.doesNotMatch(event.date, /12:00 AM/);
  });

  test("non-integer running average is rounded for display", () => {
    const { event } = buildComplianceScoreAuditItem({
      id: "cs_1", score: 94.6666666, dangerLevel: "LOW", updatedAt: new Date(),
    });
    assert.equal(event.detail, "Driver safety score: 95 out of 100");
    assert.deepEqual(event.meta, ["📊 95/100"]);
  });

  test("an exact integer average still displays cleanly", () => {
    const { event } = buildComplianceScoreAuditItem({
      id: "cs_1", score: 93, dangerLevel: "LOW", updatedAt: new Date(),
    });
    assert.equal(event.detail, "Driver safety score: 93 out of 100");
  });

  test("badgeType follows dangerLevel exactly as before", () => {
    const low = buildComplianceScoreAuditItem({ id: "1", score: 90, dangerLevel: "LOW", updatedAt: new Date() });
    const medium = buildComplianceScoreAuditItem({ id: "2", score: 60, dangerLevel: "MEDIUM", updatedAt: new Date() });
    const high = buildComplianceScoreAuditItem({ id: "3", score: 20, dangerLevel: "HIGH", updatedAt: new Date() });
    assert.equal(low.event.badgeType, "pass");
    assert.equal(medium.event.badgeType, "warn");
    assert.equal(high.event.badgeType, "fail");
  });
});

describe("buildTripAuditItem", () => {
  test("title is 'Daily Driving Summary', not 'Daily Trip'", () => {
    const { event } = buildTripAuditItem(
      { id: "t_1", updatedAt: new Date(), milesDriven: 448, weatherData: null },
      true
    );
    assert.equal(event.title, "Daily Driving Summary");
  });

  test("displayed timestamp is the row's updatedAt (latest snapshot refresh), not startedAt", () => {
    const updatedAt = new Date("2026-08-20T14:36:06.571Z");
    const { ts, event } = buildTripAuditItem(
      { id: "t_1", updatedAt, milesDriven: 448, weatherData: null },
      true
    );
    assert.equal(ts, updatedAt);
    assert.match(event.date, /2:36 PM UTC/);
  });

  test("real pilot mileage is unchanged: shown verbatim, no rounding/scaling applied here", () => {
    const { event } = buildTripAuditItem(
      { id: "t_1", updatedAt: new Date(), milesDriven: 448, weatherData: null },
      true
    );
    assert.ok(event.meta.includes("🛣 448 mi"));
  });

  test("weather/zone risk snapshot rendering is unchanged", () => {
    const { event } = buildTripAuditItem(
      {
        id: "t_1",
        updatedAt: new Date(),
        milesDriven: 448,
        weatherData: { weatherRisk: 0.05, zoneRisk: 0, locationLabel: "Shiloh Road, Seneca, SC, 29678", zoneName: null },
      },
      true
    );
    assert.equal(event.detail, "Shiloh Road, Seneca, SC, 29678");
    assert.ok(event.meta.includes("🌦 Weather Risk 5%"));
    assert.ok(event.meta.includes("🗺 Area Risk 0%"));
  });

  test("non-pilot (demo) rows are still tagged, matching prior behavior", () => {
    const { event } = buildTripAuditItem(
      { id: "t_1", updatedAt: new Date(), milesDriven: 100, weatherData: null },
      false
    );
    assert.ok(event.meta.includes("🧪 Demo Data"));
  });

  test("pilot rows are never tagged as demo data", () => {
    const { event } = buildTripAuditItem(
      { id: "t_1", updatedAt: new Date(), milesDriven: 100, weatherData: null },
      true
    );
    assert.ok(!event.meta.includes("🧪 Demo Data"));
  });
});

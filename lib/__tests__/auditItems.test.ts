import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildComplianceScoreAuditItem,
  buildTripAuditItem,
  buildDailySafetyScoreAuditItem,
  buildDailyDrivingSummaryAuditItem,
} from "../auditItems";

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

describe("buildDailySafetyScoreAuditItem", () => {
  test("title is 'Daily Safety Score', same as the legacy mapping", () => {
    const { event } = buildDailySafetyScoreAuditItem({
      id: "dss_1", averageScore: 93, sampleCount: 22, expectedSampleCount: 24,
      dangerLevel: "LOW", finalizedAt: new Date("2026-08-23T00:10:00.000Z"),
    });
    assert.equal(event.title, "Daily Safety Score");
  });

  test("shows the real sample count, not the expected count, and never implies 22/22 or 24/24", () => {
    const { event } = buildDailySafetyScoreAuditItem({
      id: "dss_1", averageScore: 93, sampleCount: 22, expectedSampleCount: 24,
      dangerLevel: "LOW", finalizedAt: new Date(),
    });
    assert.ok(event.meta.includes("22 of 24 hourly samples"));
  });

  test("displayed timestamp is finalizedAt, not the UTC-day bucket key", () => {
    const finalizedAt = new Date("2026-08-23T00:10:00.000Z");
    const { ts, event } = buildDailySafetyScoreAuditItem({
      id: "dss_1", averageScore: 93, sampleCount: 24, expectedSampleCount: 24,
      dangerLevel: "LOW", finalizedAt,
    });
    assert.equal(ts, finalizedAt);
    assert.match(event.date, /12:10 AM/);
  });

  test("rounds the average for display only", () => {
    const { event } = buildDailySafetyScoreAuditItem({
      id: "dss_1", averageScore: 92.666, sampleCount: 3, expectedSampleCount: 24,
      dangerLevel: "LOW", finalizedAt: new Date(),
    });
    assert.equal(event.detail, "Average safety score: 93 out of 100");
  });

  test("badgeType follows dangerLevel", () => {
    const high = buildDailySafetyScoreAuditItem({
      id: "dss_1", averageScore: 20, sampleCount: 10, expectedSampleCount: 24,
      dangerLevel: "HIGH", finalizedAt: new Date(),
    });
    assert.equal(high.event.badgeType, "fail");
  });
});

describe("buildDailyDrivingSummaryAuditItem", () => {
  test("title is 'Daily Driving Summary', same as the legacy mapping", () => {
    const { event } = buildDailyDrivingSummaryAuditItem({
      id: "dds_1", startLocationLabel: "Philadelphia, PA", endLocationLabel: "LaPorte County, IN",
      routeSpanAvailable: true, milesDriven: 705, weatherRiskAvg: 0.12, zoneRiskAvg: 0.08,
      finalizedAt: new Date(),
    });
    assert.equal(event.title, "Daily Driving Summary");
  });

  test("detail is 'start → end' when a route span is available", () => {
    const { event } = buildDailyDrivingSummaryAuditItem({
      id: "dds_1", startLocationLabel: "Philadelphia, PA", endLocationLabel: "LaPorte County, IN",
      routeSpanAvailable: true, milesDriven: 705, weatherRiskAvg: 0.12, zoneRiskAvg: 0.08,
      finalizedAt: new Date(),
    });
    assert.equal(event.detail, "Philadelphia, PA → LaPorte County, IN");
  });

  test("no-movement day: routeSpanAvailable false yields an honest unavailable message, never a fabricated origin/destination", () => {
    const { event } = buildDailyDrivingSummaryAuditItem({
      id: "dds_1", startLocationLabel: null, endLocationLabel: null,
      routeSpanAvailable: false, milesDriven: null, weatherRiskAvg: null, zoneRiskAvg: null,
      finalizedAt: new Date(),
    });
    assert.match(event.detail, /unavailable/i);
    assert.deepEqual(event.meta, []);
  });

  test("mileage unavailable is omitted from meta, never shown as 0", () => {
    const { event } = buildDailyDrivingSummaryAuditItem({
      id: "dds_1", startLocationLabel: "A", endLocationLabel: "B",
      routeSpanAvailable: true, milesDriven: null, weatherRiskAvg: 0.1, zoneRiskAvg: null,
      finalizedAt: new Date(),
    });
    assert.ok(!event.meta.some((m) => m.startsWith("🛣")));
    assert.ok(event.meta.includes("🌦 Weather Risk 10%"));
  });

  test("weather/zone risk averages render as rounded percentages", () => {
    const { event } = buildDailyDrivingSummaryAuditItem({
      id: "dds_1", startLocationLabel: "A", endLocationLabel: "B",
      routeSpanAvailable: true, milesDriven: 705, weatherRiskAvg: 0.12, zoneRiskAvg: 0.08,
      finalizedAt: new Date(),
    });
    assert.ok(event.meta.includes("🛣 705 mi"));
    assert.ok(event.meta.includes("🌦 Weather Risk 12%"));
    assert.ok(event.meta.includes("🗺 Area Risk 8%"));
  });
});

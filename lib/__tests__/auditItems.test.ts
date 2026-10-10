import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildComplianceScoreAuditItem,
  buildTripAuditItem,
  buildDailySafetyScoreAuditItem,
  buildDailyDrivingSummaryAuditItem,
  LEGACY_PROVENANCE_META,
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
    assert.deepEqual(event.meta, ["📊 95/100", LEGACY_PROVENANCE_META]);
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
      { id: "t_1", updatedAt: new Date(), milesDriven: 448, weatherData: null }
    );
    assert.equal(event.title, "Daily Driving Summary");
  });

  test("displayed timestamp is the row's updatedAt (latest snapshot refresh), not startedAt", () => {
    const updatedAt = new Date("2026-08-20T14:36:06.571Z");
    const { ts, event } = buildTripAuditItem(
      { id: "t_1", updatedAt, milesDriven: 448, weatherData: null }
    );
    assert.equal(ts, updatedAt);
    assert.match(event.date, /2:36 PM UTC/);
  });

  test("real pilot mileage is unchanged: shown verbatim, no rounding/scaling applied here", () => {
    const { event } = buildTripAuditItem(
      { id: "t_1", updatedAt: new Date(), milesDriven: 448, weatherData: null }
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
      }
    );
    assert.equal(event.detail, "Shiloh Road, Seneca, SC, 29678");
    assert.ok(event.meta.includes("🌦 Weather Risk 5%"));
    assert.ok(event.meta.includes("🗺 Area Risk 0%"));
  });

  // Legacy provenance label (2026-10-09). These two tests used to assert the
  // old `🧪 Demo Data` chip, applied on `!pilotDriver` — the driver's status
  // NOW, not when the row was written. They are inverted rather than deleted
  // so the old behavior cannot come back unnoticed.
  test("every retained legacy Trip row carries the provenance label", () => {
    const { event } = buildTripAuditItem(
      { id: "t_1", updatedAt: new Date(), milesDriven: 100, weatherData: null }
    );
    assert.ok(event.meta.includes(LEGACY_PROVENANCE_META));
  });

  test("the old 'Demo Data' chip is gone — it asserted a fact we cannot establish", () => {
    const { event } = buildTripAuditItem(
      { id: "t_1", updatedAt: new Date(), milesDriven: 100, weatherData: null }
    );
    assert.ok(!event.meta.includes("🧪 Demo Data"));
  });

  test("the label does not depend on the driver's current pilot status", () => {
    // The builder no longer takes pilotDriver at all, which is the
    // enforcement: there is no argument left that could vary the label.
    assert.equal(buildTripAuditItem.length, 1);
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

// ---------------------------------------------------------------------------
// Legacy provenance label (2026-10-09) — the full contract.
//
// The point of the label is that a reader can tell a legacy, unverifiable
// card apart from an autonomous, verified-real one. Both card types share
// their title, badge and score/mileage chips, so the label is the ONLY
// distinguishing signal — these tests pin that asymmetry from both sides.
describe("LEGACY_PROVENANCE_META", () => {
  const CS_ROW = { id: "cs_1", score: 68.4, dangerLevel: "MEDIUM", updatedAt: new Date("2026-07-28T10:00:00.000Z") };
  const TRIP_ROW = { id: "t_1", updatedAt: new Date("2026-07-28T10:00:00.000Z"), milesDriven: 448, weatherData: null };

  test("states unverified provenance, and does not claim the row is fake", () => {
    // Wording matters here: the row MAY be genuine. A label asserting demo
    // data would be as wrong as no label at all, in the other direction.
    assert.match(LEGACY_PROVENANCE_META, /Legacy record/);
    assert.match(LEGACY_PROVENANCE_META, /provenance unverified/);
    assert.ok(!/demo/i.test(LEGACY_PROVENANCE_META), "must not assert the row is demo/fake data");
    assert.ok(!/simulated|fabricated|mock/i.test(LEGACY_PROVENANCE_META));
  });

  test("legacy ComplianceScore cards carry it", () => {
    assert.ok(buildComplianceScoreAuditItem(CS_ROW).event.meta.includes(LEGACY_PROVENANCE_META));
  });

  test("legacy Trip cards carry it", () => {
    assert.ok(buildTripAuditItem(TRIP_ROW).event.meta.includes(LEGACY_PROVENANCE_META));
  });

  test("it is added without disturbing the existing chips", () => {
    // Appended, never replacing — the score/mileage a reader already relies
    // on must still be there, in the same form.
    const cs = buildComplianceScoreAuditItem(CS_ROW).event.meta;
    assert.ok(cs.includes("📊 68/100"));
    assert.equal(cs[cs.length - 1], LEGACY_PROVENANCE_META, "label goes last");

    const trip = buildTripAuditItem({ ...TRIP_ROW, weatherData: { weatherRisk: 0.05, zoneRisk: 0, locationLabel: "Shiloh Road", zoneName: null } }).event.meta;
    assert.ok(trip.includes("🛣 448 mi"));
    assert.ok(trip.includes("🌦 Weather Risk 5%"));
    assert.equal(trip[trip.length - 1], LEGACY_PROVENANCE_META, "label goes last");
  });

  test("appears exactly once per card", () => {
    for (const meta of [buildComplianceScoreAuditItem(CS_ROW).event.meta, buildTripAuditItem(TRIP_ROW).event.meta]) {
      assert.equal(meta.filter((m) => m === LEGACY_PROVENANCE_META).length, 1);
    }
  });

  test("the verified-real autonomous cards must NOT carry it", () => {
    // This is the half that makes the label meaningful. DailySafetyScore and
    // DailyDrivingSummary come from the autonomous riskSampling pipeline and
    // have defensible provenance; labelling them too would erase the
    // distinction the label exists to draw.
    const dss = buildDailySafetyScoreAuditItem({
      id: "dss_1", averageScore: 68.4, sampleCount: 22, expectedSampleCount: 24,
      dangerLevel: "MEDIUM", finalizedAt: new Date("2026-07-29T00:10:00.000Z"),
    }).event;
    const dds = buildDailyDrivingSummaryAuditItem({
      id: "dds_1", startLocationLabel: "A", endLocationLabel: "B", routeSpanAvailable: true,
      milesDriven: 448, weatherRiskAvg: 0.05, zoneRiskAvg: 0,
      finalizedAt: new Date("2026-07-29T00:10:00.000Z"),
    }).event;

    assert.ok(!dss.meta.includes(LEGACY_PROVENANCE_META));
    assert.ok(!dds.meta.includes(LEGACY_PROVENANCE_META));

    // And the label really is the only thing telling them apart, which is
    // why it cannot be dropped: titles and badges are identical by design.
    assert.equal(dss.title, buildComplianceScoreAuditItem(CS_ROW).event.title);
    assert.equal(dss.badge, buildComplianceScoreAuditItem(CS_ROW).event.badge);
    assert.equal(dds.title, buildTripAuditItem(TRIP_ROW).event.title);
    assert.equal(dds.badge, buildTripAuditItem(TRIP_ROW).event.badge);
  });
});

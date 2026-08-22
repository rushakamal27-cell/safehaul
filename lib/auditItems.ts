/**
 * lib/auditItems.ts
 *
 * Pure row -> Audit-event mapping for Audit timeline items, extracted out of
 * app/api/audit/route.ts so title/timestamp/rounding/labeling behavior is
 * unit-testable under the lib/**\/__tests__ pattern.
 *
 * buildComplianceScoreAuditItem / buildTripAuditItem: the legacy,
 * app-open-driven ComplianceScore/Trip mapping (Daily Trip / Daily
 * Compliance Score correction pass). Still used for demo (non-pilot)
 * drivers, who have no autonomous collection pipeline, and for pre-cutover
 * pilot history — see app/api/audit/route.ts's legacy-dedup logic.
 *
 * buildDailySafetyScoreAuditItem / buildDailyDrivingSummaryAuditItem: the
 * new, autonomous/post-factum finalized-history mapping
 * (DailySafetyScore/DailyDrivingSummary — see lib/riskSampling/). Titled
 * identically to the legacy pass's renamed titles ("Daily Safety Score" /
 * "Daily Driving Summary") — from the Audit reader's perspective this is a
 * continuation of the same card type, just now finalized once per day
 * instead of live-updated on every app open.
 */

import type { AuditEvent } from "@/lib/audit";
import { formatAuditDate } from "@/lib/auditFormatting";

export interface StampedAuditEvent {
  ts: Date;
  event: AuditEvent;
}

export interface ComplianceScoreAuditRow {
  id: string;
  score: number;
  dangerLevel: string;
  updatedAt: Date;
}

/**
 * cs.score is a running arithmetic mean (Float, unrounded in the DB — see
 * lib/complianceScoreAverage.ts) across every /api/risk calculation this
 * UTC day; rounded only here, for display, never written back.
 *
 * cs.updatedAt is the real time of the most recent calculation folded into
 * today's average. cs.date (the UTC-day bucket key, always midnight) is
 * deliberately not used here — that's what produced the misleading
 * "12:00 AM" display; a bucket key must never be shown as a calculation
 * time.
 */
export function buildComplianceScoreAuditItem(cs: ComplianceScoreAuditRow): StampedAuditEvent {
  const badgeType: AuditEvent["badgeType"] =
    cs.dangerLevel === "LOW" ? "pass" :
    cs.dangerLevel === "MEDIUM" ? "warn" : "fail";
  const displayScore = Math.round(cs.score);
  return {
    ts: cs.updatedAt,
    event: {
      id: cs.id,
      date: formatAuditDate(cs.updatedAt),
      badge: `${cs.dangerLevel} RISK`,
      badgeType,
      title: "Daily Safety Score",
      detail: `Driver safety score: ${displayScore} out of 100`,
      meta: [`📊 ${displayScore}/100`],
    },
  };
}

export interface TripAuditRow {
  id: string;
  updatedAt: Date;
  milesDriven: number;
  weatherData: unknown;
}

/**
 * trip.updatedAt is when the displayed mileage/location/weather/zone
 * snapshot was last written — every /api/risk call updates this row, so
 * updatedAt tracks the actual snapshot, unlike startedAt (only the day's
 * first /api/risk call, which the snapshot may have long since moved past).
 */
export function buildTripAuditItem(trip: TripAuditRow, pilotDriver: boolean): StampedAuditEvent {
  const weather = trip.weatherData as Record<string, any> | null;
  const miles   = trip.milesDriven > 0 ? `${trip.milesDriven} mi` : null;
  const loc     = weather?.locationLabel ?? null;
  const zone    = weather?.zoneName      ?? null;
  return {
    ts: trip.updatedAt,
    event: {
      id:        trip.id,
      date:      formatAuditDate(trip.updatedAt),
      badge:     "TRIP",
      badgeType: "info",
      title:     "Daily Driving Summary",
      detail:    [loc, zone].filter(Boolean).join(" · ") || "Trip logged. Location data not available.",
      meta: [
        ...(miles ? [`🛣 ${miles}`] : []),
        ...(weather?.weatherRisk != null
          ? [`🌦 Weather Risk ${Math.round(weather.weatherRisk * 100)}%`]
          : []),
        ...(weather?.zoneRisk != null
          ? [`🗺 Area Risk ${Math.round(weather.zoneRisk * 100)}%`]
          : []),
        ...(!pilotDriver ? ["🧪 Demo Data"] : []),
      ],
    },
  };
}

export interface DailySafetyScoreAuditRow {
  id: string;
  averageScore: number;
  sampleCount: number;
  expectedSampleCount: number;
  dangerLevel: string;
  finalizedAt: Date;
}

/**
 * dss.averageScore is the true arithmetic mean over exactly dss.sampleCount
 * valid hourly samples (lib/riskSampling/dailyAverage.ts) — never divided by
 * expectedSampleCount. Rounded only here, for display, never written back.
 * dss.finalizedAt (not dss.date, the UTC-day bucket key) is the displayed
 * timestamp — same "never show a bucket key as a calculation time" rule the
 * legacy ComplianceScore mapping already established.
 */
export function buildDailySafetyScoreAuditItem(dss: DailySafetyScoreAuditRow): StampedAuditEvent {
  const badgeType: AuditEvent["badgeType"] =
    dss.dangerLevel === "LOW" ? "pass" :
    dss.dangerLevel === "MEDIUM" ? "warn" : "fail";
  const displayScore = Math.round(dss.averageScore);
  return {
    ts: dss.finalizedAt,
    event: {
      id: dss.id,
      date: formatAuditDate(dss.finalizedAt),
      badge: `${dss.dangerLevel} RISK`,
      badgeType,
      title: "Daily Safety Score",
      detail: `Average safety score: ${displayScore} out of 100`,
      meta: [
        `📊 ${displayScore}/100`,
        `${dss.sampleCount} of ${dss.expectedSampleCount} hourly samples`,
      ],
    },
  };
}

export interface DailyDrivingSummaryAuditRow {
  id: string;
  startLocationLabel: string | null;
  endLocationLabel: string | null;
  routeSpanAvailable: boolean;
  milesDriven: number | null;
  weatherRiskAvg: number | null;
  zoneRiskAvg: number | null;
  finalizedAt: Date;
}

/**
 * dds.startLocationLabel/endLocationLabel describe the daily OBSERVED ROUTE
 * SPAN (earliest/latest moving DriverObservation that day —
 * lib/riskSampling/routeSpan.ts) — never a single Samsara "trip" and never a
 * reconstruction of stop-by-stop chronology. dds.milesDriven/weatherRiskAvg/
 * zoneRiskAvg are each independently nullable; a null field is omitted from
 * meta rather than ever displayed as 0 or "unavailable" text mixed with real
 * numbers.
 */
export function buildDailyDrivingSummaryAuditItem(dds: DailyDrivingSummaryAuditRow): StampedAuditEvent {
  const miles = dds.milesDriven !== null ? `${Math.round(dds.milesDriven)} mi` : null;
  const routeDetail =
    dds.routeSpanAvailable && (dds.startLocationLabel || dds.endLocationLabel)
      ? [dds.startLocationLabel, dds.endLocationLabel].filter(Boolean).join(" → ")
      : "Route span unavailable — no trustworthy moving observation this day.";
  return {
    ts: dds.finalizedAt,
    event: {
      id: dds.id,
      date: formatAuditDate(dds.finalizedAt),
      badge: "TRIP",
      badgeType: "info",
      title: "Daily Driving Summary",
      detail: routeDetail,
      meta: [
        ...(miles ? [`🛣 ${miles}`] : []),
        ...(dds.weatherRiskAvg !== null ? [`🌦 Weather Risk ${Math.round(dds.weatherRiskAvg * 100)}%`] : []),
        ...(dds.zoneRiskAvg !== null ? [`🗺 Area Risk ${Math.round(dds.zoneRiskAvg * 100)}%`] : []),
      ],
    },
  };
}

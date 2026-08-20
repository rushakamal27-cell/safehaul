/**
 * lib/auditItems.ts
 *
 * Pure row -> Audit-event mapping for the two items touched by the
 * Daily Trip / Daily Compliance Score correction pass, extracted out of
 * app/api/audit/route.ts so the title/timestamp/rounding behavior is
 * unit-testable under the lib/**\/__tests__ pattern. No behavior change
 * from extraction itself — same output the inline code produced.
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

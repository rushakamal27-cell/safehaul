import { NextRequest, NextResponse } from "next/server";
import { getMockAuditEvents, AuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { isPilotDriver } from "@/lib/driverEvents";
import { formatAuditDate } from "@/lib/auditFormatting";
import {
  buildComplianceScoreAuditItem,
  buildTripAuditItem,
  buildDailySafetyScoreAuditItem,
  buildDailyDrivingSummaryAuditItem,
} from "@/lib/auditItems";
import { utcDayKey } from "@/lib/riskSampling/dayBounds";

function formatEventType(raw: string): string {
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  // Fetch all real event tables in parallel
  const [
    pilotDriver, incidents, safetyEvents, complianceScores, trips, inspections, driverEventsRaw,
    dailySafetyScores, dailyDrivingSummaries,
  ] = await Promise.all([
    isPilotDriver(driverId),
    prisma.incident.findMany({ where: { driverId }, orderBy: { createdAt: "desc" } }),
    prisma.safetyEvent.findMany({ where: { driverId }, orderBy: { timestamp: "desc" } }),
    prisma.complianceScore.findMany({ where: { driverId }, orderBy: { date: "desc" } }),
    prisma.trip.findMany({ where: { driverId }, orderBy: { startedAt: "desc" } }),
    prisma.inspection.findMany({ where: { driverId }, orderBy: { createdAt: "desc" } }),
    prisma.driverEvent.findMany({
      where: { driverId },
      orderBy: { timestamp: "desc" },
      include: { rawProviderEvent: { select: { source: true } } },
    }),
    // Autonomous, post-factum finalized history (lib/riskSampling/) — only
    // ever populated for pilot driverIds; empty for demo drivers.
    prisma.dailySafetyScore.findMany({ where: { driverId }, orderBy: { date: "desc" } }),
    prisma.dailyDrivingSummary.findMany({ where: { driverId }, orderBy: { date: "desc" } }),
  ]);

  // Intermediate type for unified sort before stripping timestamp
  type Stamped = { ts: Date; event: AuditEvent };

  const incidentItems: Stamped[] = incidents.map((inc) => ({
    ts: inc.createdAt,
    event: {
      id: inc.id,
      date: formatAuditDate(inc.createdAt),
      badge: "INCIDENT",
      badgeType: "fail" as const,
      title: "Incident Report",
      detail: inc.description ?? "No description provided.",
      meta: [
        ...(inc.location ? [`📍 ${inc.location}`] : []),
        "Driver-initiated report",
      ],
    },
  }));

  // prisma.SafetyEvent rows are only ever written for non-pilot/demo drivers
  // (see the `if (!pilotDriver && ...)` guard in app/api/risk/route.ts —
  // pilot drivers' real events live in DriverEvent instead, surfaced below
  // as driverEventItems). That makes every row here simulated data by
  // construction, regardless of the driver's CURRENT pilot status — so this
  // is always tagged, unconditionally, unlike the trip-snapshot tag below.
  const safetyItems: Stamped[] = safetyEvents.map((ev) => {
    const sev = parseInt(ev.severity, 10);
    const badgeType: AuditEvent["badgeType"] =
      sev >= 4 ? "fail" : sev === 3 ? "warn" : "info";
    const badge = sev >= 4 ? "HIGH ALERT" : sev === 3 ? "WARNING" : "NOTICE";
    return {
      ts: ev.timestamp,
      event: {
        id: ev.id,
        date: formatAuditDate(ev.timestamp),
        badge,
        badgeType,
        title: formatEventType(ev.eventType),
        detail: `Severity ${ev.severity}/5 · Simulated by SafeHaul's demo safety system (not real telematics).`,
        meta: [
          ...(ev.lat && ev.lng ? [`📍 GPS location recorded`] : []),
          `⚠ Severity ${ev.severity}/5`,
          "🧪 Demo Data",
        ],
      },
    };
  });

  // Legacy-transition dedup (Part 10): /api/risk stopped writing new
  // ComplianceScore/Trip rows for pilot drivers on cutover — see
  // lib/riskPersistence.ts — but a driver who opened the app on the
  // cutover's own UTC day may already have a partial legacy row for that
  // same day, which the autonomous finalizer will ALSO produce a
  // DailySafetyScore/DailyDrivingSummary row for once that day ends. Rather
  // than show both for one day, the new finalized row always wins — a
  // deterministic rule keyed on UTC day, applied per model independently
  // (a day could in principle finalize one but not the other). Every
  // legacy row from before the cutover has no corresponding new-model row
  // at all and is therefore never affected by this filter.
  const finalizedScoreDays = new Set(dailySafetyScores.map((dss) => utcDayKey(dss.date)));
  const finalizedSummaryDays = new Set(dailyDrivingSummaries.map((dds) => utcDayKey(dds.date)));

  const complianceItems: Stamped[] = complianceScores
    .filter((cs) => !finalizedScoreDays.has(utcDayKey(cs.date)))
    .map(buildComplianceScoreAuditItem);

  // trip.weatherData is written fresh on every /api/risk call for the
  // driver's CURRENT pilot status (app/api/risk/route.ts's
  // weatherDataSnapshot) — real per-field values for a pilot, fully mock
  // scenario values for a non-pilot. There's no per-row stored flag for what
  // it was at write time, so `pilotDriver` (current status) is used as an
  // approximation, same simplification pattern as todaySummary's UTC-day
  // "today" — a driver whose pilot status changed since a given trip could
  // see it mislabeled, but that's a narrow historical edge case, not the
  // common "is this Trip's data real" question this tag answers.
  const tripItems: Stamped[] = trips
    .filter((trip) => !finalizedSummaryDays.has(utcDayKey(trip.startedAt)))
    .map((trip) => buildTripAuditItem(trip, pilotDriver));

  const dailySafetyScoreItems: Stamped[] = dailySafetyScores.map(buildDailySafetyScoreAuditItem);
  const dailyDrivingSummaryItems: Stamped[] = dailyDrivingSummaries.map(buildDailyDrivingSummaryAuditItem);

  const inspectionItems: Stamped[] = inspections.map((ins) => {
    const badgeType: AuditEvent["badgeType"] =
      ins.overallResult === "PASS" ? "pass" :
      ins.overallResult === "WARN" ? "warn" : "fail";
    const badge =
      ins.overallResult === "PASS" ? "PASSED" :
      ins.overallResult === "WARN" ? "WARNING" : "FAILED";
    return {
      ts: ins.createdAt,
      event: {
        id:        ins.id,
        date:      formatAuditDate(ins.createdAt),
        badge,
        badgeType,
        title:     "Pre-Trip Inspection",
        detail:    ins.summary,
        meta: [
          "📷 Photo analyzed",
          `🎯 ${Math.round(ins.confidence * 100)}% confidence`,
        ],
      },
    };
  });

  const driverEventItems: Stamped[] = driverEventsRaw.map((de) => {
    const sev = Math.round(de.severity);
    const badgeType: AuditEvent["badgeType"] =
      sev >= 4 ? "fail" : sev === 3 ? "warn" : "info";
    const badge = sev >= 4 ? "HIGH ALERT" : sev === 3 ? "WARNING" : "NOTICE";
    const providerLabel =
      de.provider.charAt(0).toUpperCase() + de.provider.slice(1); // "Samsara"
    const sourceLabel =
      de.rawProviderEvent?.source === "stream" ? "Stream" : "Webhook";
    return {
      ts: de.timestamp,
      event: {
        id:        de.id,
        date:      formatAuditDate(de.timestamp),
        badge,
        badgeType,
        title:     formatEventType(de.type), // "Mobile Usage", "Harsh Braking", etc.
        detail:    `Detected by ${providerLabel} onboard telematics.`,
        meta: [
          `📡 ${providerLabel} · ${sourceLabel}`,
          `⚠ Severity ${sev}/5`,
          ...(de.lat && de.lng ? ["📍 GPS recorded"] : []),
        ],
      },
    };
  });

  // Merge all real events, sorted by timestamp descending
  const allReal = [
    ...incidentItems,
    ...safetyItems,
    ...complianceItems,
    ...tripItems,
    ...dailySafetyScoreItems,
    ...dailyDrivingSummaryItems,
    ...inspectionItems,
    ...driverEventItems,
  ]
    .sort((a, b) => b.ts.getTime() - a.ts.getTime())
    .map((s) => s.event);

  // Return real events, or mock demo data only when ?demo=1 is explicitly set.
  // Default for drivers with no real rows is an empty array (empty-state UI).
  const demo = request.nextUrl.searchParams.get("demo") === "1";
  const events = allReal.length > 0 ? allReal : (demo ? getMockAuditEvents(driverId) : []);

  return NextResponse.json({
    driverId,
    generatedAt: new Date().toISOString(),
    events,
  });
}

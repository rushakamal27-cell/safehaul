import { NextRequest, NextResponse } from "next/server";
import { getMockAuditEvents, AuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { formatAuditDate } from "@/lib/auditFormatting";
import {
  buildComplianceScoreAuditItem,
  buildTripAuditItem,
  buildDailySafetyScoreAuditItem,
  buildDailyDrivingSummaryAuditItem,
} from "@/lib/auditItems";
import { utcDayKey } from "@/lib/riskSampling/dayBounds";
import { isLegacySyntheticRow } from "@/lib/dataQuality/legacyHistory";

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
    providerMapping, incidents, safetyEvents, complianceScores, trips, inspections, driverEventsRaw,
    dailySafetyScores, dailyDrivingSummaries,
  ] = await Promise.all([
    // When this driver was first mapped to ANY provider, regardless of the
    // mapping's current isPilot/isActive flags. Sole input to the legacy
    // synthetic-row classification below — see
    // lib/dataQuality/legacyHistory.ts. findFirst with the oldest row: a
    // driver can in principle hold mappings for several providers, and the
    // EARLIEST is the conservative choice, since any row predating it
    // predates every mapping the driver has ever had.
    prisma.driverProviderMapping.findFirst({
      where: { driverId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
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

  // Legacy synthetic-history exclusion (2026-10-08). Trip, ComplianceScore
  // and SafetyEvent are the three tables the deleted /api/risk daily-history
  // block wrote, and for a driver with no active pilot mapping everything it
  // wrote was derived from mock scenario data. Those rows are hidden here
  // rather than deleted: this is a read-time filter over untouched
  // production records. Rows that cannot be POSITIVELY identified as
  // synthetic are still shown — see lib/dataQuality/legacyHistory.ts for the
  // rule, why it reads createdAt rather than the backfill-corrupted
  // updatedAt, and why it takes no date threshold of its own.
  const providerMappingCreatedAt = providerMapping?.createdAt ?? null;
  const isSynthetic = (rowCreatedAt: Date): boolean =>
    isLegacySyntheticRow({ rowCreatedAt, providerMappingCreatedAt });

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

  // SafetyEvent rows were only ever written by the non-pilot branch of the
  // (now deleted) /api/risk daily-history block — pilot drivers' real events
  // live in DriverEvent instead, surfaced below as driverEventItems. So every
  // row is synthetic, and the classifier confirms it independently rather
  // than this code asserting it: measured against production, all 93 rows are
  // caught by rules 1 and 2 (51 belong to never-mapped drivers, 42 predate
  // their driver's mapping, 0 fall through to ambiguous), and none carries a
  // samsaraEventId. The filter is therefore expected to remove all of them,
  // but it is applied as a filter rather than an unconditional drop so that
  // a row which somehow did not match is surfaced instead of silently
  // discarded.
  const safetyItems: Stamped[] = safetyEvents
    .filter((ev) => !isSynthetic(ev.createdAt))
    .map((ev) => {
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
  // ComplianceScore/Trip rows for pilot drivers on cutover (and, as of
  // Remove Implicit Demo Fallback 2026-10-08, stopped writing them for
  // EVERY driver) — but a driver who opened the app on the
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
    .filter((cs) => !isSynthetic(cs.createdAt))
    .map(buildComplianceScoreAuditItem);

  // buildTripAuditItem no longer takes pilotDriver (2026-10-09). It used the
  // driver's CURRENT pilot status to decide whether to tag a row "🧪 Demo
  // Data", which was the wrong question: the row's trustworthiness depends on
  // what the driver's status was WHEN IT WAS WRITTEN, which nothing records.
  // Every row still reaching this builder is an `ambiguous` legacy row, so it
  // now carries LEGACY_PROVENANCE_META unconditionally instead.
  const tripItems: Stamped[] = trips
    .filter((trip) => !finalizedSummaryDays.has(utcDayKey(trip.startedAt)))
    .filter((trip) => !isSynthetic(trip.createdAt))
    .map((trip) => buildTripAuditItem(trip));

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

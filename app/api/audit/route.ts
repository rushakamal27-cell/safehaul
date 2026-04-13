import { NextRequest, NextResponse } from "next/server";
import { getMockAuditEvents, AuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

function formatAuditDate(date: Date): string {
  return `📅 ${date
    .toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    .toUpperCase()}`;
}

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
  const [incidents, safetyEvents, complianceScores, trips] = await Promise.all([
    prisma.incident.findMany({ where: { driverId }, orderBy: { createdAt: "desc" } }),
    prisma.safetyEvent.findMany({ where: { driverId }, orderBy: { timestamp: "desc" } }),
    prisma.complianceScore.findMany({ where: { driverId }, orderBy: { date: "desc" } }),
    prisma.trip.findMany({ where: { driverId }, orderBy: { startedAt: "desc" } }),
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
        detail: `Severity ${ev.severity}/5 · Recorded by the vehicle's onboard safety system.`,
        meta: [
          ...(ev.lat && ev.lng ? [`📍 GPS location recorded`] : []),
          `⚠ Severity ${ev.severity}/5`,
        ],
      },
    };
  });

  const complianceItems: Stamped[] = complianceScores.map((cs) => {
    const badgeType: AuditEvent["badgeType"] =
      cs.dangerLevel === "LOW" ? "pass" :
      cs.dangerLevel === "MEDIUM" ? "warn" : "fail";
    return {
      ts: cs.date,
      event: {
        id: cs.id,
        date: formatAuditDate(cs.date),
        badge: `${cs.dangerLevel} RISK`,
        badgeType,
        title: "Daily Compliance Score",
        detail: `Driver safety score: ${cs.score} out of 100`,
        meta: [`📊 ${cs.score}/100`],
      },
    };
  });

  const tripItems: Stamped[] = trips.map((trip) => {
    const weather = trip.weatherData as Record<string, any> | null;
    const miles   = trip.milesDriven > 0 ? `${trip.milesDriven} mi` : null;
    const loc     = weather?.locationLabel ?? null;
    const zone    = weather?.zoneName      ?? null;
    return {
      ts: trip.startedAt,
      event: {
        id:        trip.id,
        date:      formatAuditDate(trip.startedAt),
        badge:     "TRIP",
        badgeType: "info" as const,
        title:     "Daily Trip",
        detail:    [loc, zone].filter(Boolean).join(" · ") || "Trip logged. Location data not available.",
        meta: [
          ...(miles ? [`🛣 ${miles}`] : []),
          ...(weather?.weatherRisk != null
            ? [`🌦 Weather Risk ${Math.round(weather.weatherRisk * 100)}%`]
            : []),
          ...(weather?.zoneRisk != null
            ? [`🗺 Area Risk ${Math.round(weather.zoneRisk * 100)}%`]
            : []),
        ],
      },
    };
  });

  // Merge all real events, sorted by timestamp descending
  const allReal = [...incidentItems, ...safetyItems, ...complianceItems, ...tripItems]
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

/**
 * lib/audit.ts
 *
 * Mock audit data layer for SafeHaul.
 * AuditEvent maps directly to the props consumed by the EventCard UI component.
 * TODO: Replace getMockAuditEvents with real DB queries against the
 *       Incident, SafetyEvent, and ComplianceScore Prisma models.
 */

export type BadgeType = "pass" | "fail" | "warn" | "info";

export interface AuditEvent {
  id: string;
  date: string;
  badge: string;
  badgeType: BadgeType;
  title: string;
  detail: string;
  meta: string[];
}

export interface AuditData {
  driverId: string;
  generatedAt: string;
  events: AuditEvent[];
}

export function getMockAuditEvents(driverId: string): AuditEvent[] {
  // TODO: query prisma.incident, prisma.safetyEvent, prisma.complianceScore
  //       filtered by driverId, ordered by timestamp desc
  return [
    {
      id: `${driverId}-evt-1`,
      date: "📅 MAR 10, 2026 · 06:42 AM",
      badge: "PASSED",
      badgeType: "pass",
      title: "Pre-Trip Inspection",
      detail: "Vehicle #TRK-4471 · Driver: M. Rodriguez · 18 points verified · 1 warning logged",
      meta: ["📍 Savannah, GA", "🎙 4m 12s", "📷 12 photos"],
    },
    {
      id: `${driverId}-evt-2`,
      date: "📅 MAR 10, 2026 · 09:18 AM",
      badge: "INCIDENT",
      badgeType: "fail",
      title: "Air Brake Failure — I-16 MM 47",
      detail: "Rear axle brake line coupling failure. FMCSA §393.45 violation logged. Protocol initiated.",
      meta: ["📍 MM 47, I-16 W", "🎙 8m 33s", "🛠 DOT notified"],
    },
    {
      id: `${driverId}-evt-3`,
      date: "📅 MAR 10, 2026 · 11:05 AM",
      badge: "PASSED",
      badgeType: "pass",
      title: "Roadside Inspection — Level II",
      detail: "Officer Martinez · Badge #4892 · Vehicle cleared after brake line repair.",
      meta: ["📍 US-17 N Weigh Station", "🎙 2m 07s", "📄 Cert. #RS-2026-0310"],
    },
    {
      id: `${driverId}-evt-4`,
      date: "📅 MAR 09, 2026 · 15:30 PM",
      badge: "WARNING",
      badgeType: "warn",
      title: "HOS Log — 30-Min Rest Reminder",
      detail: "Driver approaching 8-hour mark. Break taken at Pilot TA #1142.",
      meta: ["📍 Brunswick, GA", "⏱ 8h 02m elapsed"],
    },
    {
      id: `${driverId}-evt-5`,
      date: "📅 MAR 09, 2026 · 06:15 AM",
      badge: "PRE-TRIP",
      badgeType: "info",
      title: "Pre-Trip Inspection — Jacksonville FL",
      detail: "All 18 checkpoints passed. Zero defects. Compliance score: 100/100.",
      meta: ["📍 Jacksonville, FL", "🎙 3m 45s", "📷 10 photos"],
    },
  ];
}

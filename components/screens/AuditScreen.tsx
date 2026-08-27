"use client";

import { useEffect, useState } from "react";
import { useTelegram } from "@/lib/useTelegram";
import { AuditEvent } from "@/lib/audit";
import type { LocationApiResponse } from "@/lib/api/location";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import {
  translateAuditBadge,
  translateAuditTitle,
  translateAuditDetail,
  translateAuditMeta,
} from "@/lib/i18n/auditLabels";
import type { Language, TranslationKey } from "@/lib/i18n/translations";
import {
  LogIn, CheckCircle2, Truck, ClipboardCheck, AlertTriangle,
  Zap, ChevronRight, BarChart2, TrendingUp, Calendar,
  FileSearch, Download, Circle,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getTimelineIcon(badgeType: AuditEvent["badgeType"], title: string) {
  const props = { size: 15, strokeWidth: 1.75 };
  const lower = title.toLowerCase();
  if (lower.includes("trip") || lower.includes("driving")) return <Truck {...props} />;
  if (lower.includes("inspection"))  return <ClipboardCheck {...props} />;
  if (lower.includes("login") || lower.includes("driver login")) return <LogIn {...props} />;
  if (lower.includes("compliance") || lower.includes("score"))   return <CheckCircle2 {...props} />;
  if (lower.includes("incident"))    return <AlertTriangle {...props} />;
  // Crash (2026-08-xx): without this, a real Samsara Crash event's title
  // ("Crash", via formatEventType) matches none of the branches below and
  // falls through to the generic Circle icon — the exact "accidentally
  // becomes an unknown/generic event" outcome this event type must avoid.
  if (lower.includes("crash"))       return <AlertTriangle {...props} />;
  if (lower.includes("mobile") || lower.includes("braking") || lower.includes("usage") || lower.includes("harsh") || lower.includes("inattentive")) {
    return <Zap {...props} />;
  }
  if (badgeType === "fail")          return <AlertTriangle {...props} />;
  if (badgeType === "pass")          return <CheckCircle2 {...props} />;
  return <Circle {...props} />;
}

function getTimelineColors(badgeType: AuditEvent["badgeType"]): { dot: string; icon: string } {
  switch (badgeType) {
    case "pass": return { dot: "var(--green)",   icon: "var(--green)"   };
    case "fail": return { dot: "var(--red)",     icon: "var(--red)"     };
    case "warn": return { dot: "var(--warning)", icon: "var(--warning)" };
    default:     return { dot: "var(--blue)",    icon: "var(--blue)"    };
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function TimelineItem({ evt, isLast, language }: { evt: AuditEvent; isLast: boolean; onClick: () => void; language: Language }) {
  const colors = getTimelineColors(evt.badgeType);
  // Icon selection deliberately keys off the ORIGINAL English evt.title
  // (not the translated display title below) — see
  // lib/i18n/auditLabels.ts's file header: this keeps icon selection
  // robust regardless of display language, matching the Plan Mode report's
  // "Dynamic label strategy" section E.
  const icon = getTimelineIcon(evt.badgeType, evt.title);

  const title  = translateAuditTitle(evt.title, language);
  const badge  = translateAuditBadge(evt.badge, language);
  const detail = translateAuditDetail(evt.detail, language);
  const meta   = translateAuditMeta(evt.meta, language);

  return (
    <div style={{ display: "flex", gap: 14 }}>
      {/* Timeline track */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 32, flexShrink: 0 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "var(--bg-secondary)",
            border: `1.5px solid ${colors.dot}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: colors.icon,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        {!isLast && (
          <div
            style={{
              width: 1,
              flex: 1,
              minHeight: 16,
              background: "var(--border)",
              marginTop: 4,
            }}
          />
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, paddingBottom: isLast ? 0 : 20, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)", lineHeight: 1.3 }}>
            {title}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: colors.dot,
              background: `${colors.dot}18`,
              border: `1px solid ${colors.dot}33`,
              borderRadius: 99,
              padding: "2px 8px",
              flexShrink: 0,
              letterSpacing: "0.3px",
            }}
          >
            {badge}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 4 }}>
          {detail}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
          {evt.date.replace("📅 ", "")}
        </div>
        {meta.length > 0 && (
          <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
            {meta.map((m, i) => (
              <span key={`${m}-${i}`} style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                {m}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ReportEntry {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: string;
}

/** Builds the four report cards' text from the current language — a plain function (not a hook) since it does no state/effect work of its own, just a t()-driven mapping recomputed on each render. */
function buildReports(t: (key: TranslationKey) => string): ReportEntry[] {
  return [
    { icon: <Calendar size={18} strokeWidth={1.75} />,   title: t("reportDailyTitle"),   description: t("reportDailyDesc"),   color: "var(--blue)"    },
    { icon: <BarChart2 size={18} strokeWidth={1.75} />,  title: t("reportWeeklyTitle"),  description: t("reportWeeklyDesc"),  color: "var(--green)"   },
    { icon: <TrendingUp size={18} strokeWidth={1.75} />, title: t("reportMonthlyTitle"), description: t("reportMonthlyDesc"), color: "var(--warning)" },
    { icon: <FileSearch size={18} strokeWidth={1.75} />, title: t("reportCustomTitle"),  description: t("reportCustomDesc"),  color: "var(--blue)"    },
  ];
}

function ReportCard({ report, onClick }: { report: ReportEntry; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 16px",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          background: `${report.color}14`,
          border: `1px solid ${report.color}30`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: report.color,
          flexShrink: 0,
        }}
      >
        {report.icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)", marginBottom: 2 }}>
          {report.title}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {report.description}
        </div>
      </div>
      <Download size={16} strokeWidth={1.75} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

type AuditTab = "log" | "reports";

export function AuditScreen({
  onGenerateReport,
  onExpandCard,
}: {
  onGenerateReport: () => void;
  onExpandCard: () => void;
}) {
  const telegramUser = useTelegram();
  const { language, t } = useLanguage();
  const reports = buildReports(t);

  const [events,   setEvents]   = useState<AuditEvent[]>([]);
  const [location, setLocation] = useState<LocationApiResponse | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [showAll,  setShowAll]  = useState(false);
  const [tab,      setTab]      = useState<AuditTab>("log");

  const PAGE          = 10;
  const visibleEvents = showAll ? events : events.slice(0, PAGE);
  const hasMore       = events.length > PAGE;

  // ── Data loading (unchanged) ─────────────────────────────────────────────────
  useEffect(() => {
    if (!telegramUser) return;
    let cancelled = false;

    async function loadAudit() {
      try {
        const driverRes = await fetch("/api/driver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            telegramUserId: telegramUser!.id,
            name: telegramUser!.firstName,
          }),
        });
        if (!driverRes.ok) throw new Error(`Driver API failed: ${driverRes.status}`);
        const { driver } = await driverRes.json();

        const [auditRes, locationRes] = await Promise.all([
          fetch(`/api/audit?driverId=${driver.id}`),
          fetch(`/api/location?driverId=${driver.id}`),
        ]);
        if (!auditRes.ok) throw new Error(`Audit API failed: ${auditRes.status}`);
        const data = await auditRes.json();

        if (!cancelled) {
          setEvents(data.events);
          if (locationRes.ok) setLocation(await locationRes.json());
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message ?? "Failed to load audit data");
          setLoading(false);
        }
      }
    }

    loadAudit();
    return () => { cancelled = true; };
  }, [telegramUser]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in" style={{ padding: "24px 20px 8px" }}>

      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.4px" }}>
            {t("auditTrail")}
          </div>
          {location && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>
              {location.locationLabel}
            </div>
          )}
        </div>
      </div>

      {/* Segmented control */}
      <div
        style={{
          display: "flex",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 4,
          marginBottom: 24,
        }}
      >
        {(["log", "reports"] as AuditTab[]).map((tabId) => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            style={{
              flex: 1,
              padding: "8px 0",
              borderRadius: 9,
              border: "none",
              background: tab === tabId ? "var(--card)" : "transparent",
              color: tab === tabId ? "var(--text-primary)" : "var(--text-tertiary)",
              fontSize: 13,
              fontWeight: tab === tabId ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: tab === tabId ? "0 1px 3px rgba(0,0,0,0.3)" : "none",
            }}
          >
            {t(tabId === "log" ? "tabLog" : "tabReports")}
          </button>
        ))}
      </div>

      {/* ── Log tab ──────────────────────────────────────────────────────────── */}
      {tab === "log" && (
        <>
          {loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{ display: "flex", gap: 14 }}>
                  <div className="skeleton" style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0 }} />
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div className="skeleton" style={{ height: 14, width: "60%" }} />
                    <div className="skeleton" style={{ height: 12, width: "80%" }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div style={{ fontSize: 13, color: "var(--red)", textAlign: "center", padding: "24px 0" }}>
              {t("failedLoadAudit")}
            </div>
          )}

          {!loading && !error && events.length === 0 && (
            <div style={{ textAlign: "center", padding: "48px 0" }}>
              <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>{t("noActivity")}</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>{t("openDashboardToTrack")}</div>
            </div>
          )}

          {!loading && !error && visibleEvents.length > 0 && (
            <div>
              {visibleEvents.map((evt, i) => (
                <TimelineItem
                  key={evt.id}
                  evt={evt}
                  isLast={i === visibleEvents.length - 1 && !hasMore}
                  onClick={onExpandCard}
                  language={language}
                />
              ))}

              {hasMore && (
                <button
                  onClick={() => setShowAll((prev) => !prev)}
                  style={{
                    width: "100%",
                    marginTop: 8,
                    padding: "12px 0",
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--blue)",
                    cursor: "pointer",
                  }}
                >
                  {showAll
                    ? t("showFewerEvents")
                    : t("viewMoreEvents", { n: events.length - PAGE })}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Reports tab ───────────────────────────────────────────────────────── */}
      {tab === "reports" && (
        <div>
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 20,
              overflow: "hidden",
            }}
          >
            {reports.map((report, i) => (
              <div
                key={report.title}
                style={{
                  borderBottom: i < reports.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <ReportCard report={report} onClick={onGenerateReport} />
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, padding: "14px 16px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}>
              {t("fmcsaExportTitle")}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 14 }}>
              {t("fmcsaExportDesc")}
            </div>
            <button
              onClick={onGenerateReport}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 16px",
                background: "var(--blue-dim)",
                border: "1px solid var(--blue-border)",
                borderRadius: 10,
                color: "var(--blue)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <Download size={15} strokeWidth={1.75} />
              {t("exportFmcsaReport")}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

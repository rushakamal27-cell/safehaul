"use client";

import { useEffect, useState } from "react";
import { RiskInput, RiskOutput } from "@/lib/riskEngine";
import { useTelegram } from "@/lib/useTelegram";
import type { DriverLocation } from "@/lib/location";
import {
  Cloud, Moon, Gauge, MapPin, Smartphone, AlertTriangle,
  Wrench, Info, ChevronRight, TriangleAlert,
} from "lucide-react";

// ── Types (unchanged) ──────────────────────────────────────────────────────────

interface LiveData {
  provider: string;
  lastEventType: string | null;
  lastEventTimestamp: string | null;
  lastSyncTime: string | null;
  driverEventCount24h: number;
}

interface RiskResponse {
  driverId: string;
  timestamp: string;
  dataSource: "real" | "mock";
  liveData: LiveData | null;
  input: RiskInput;
  result: RiskOutput;
}

// ── Design helpers ─────────────────────────────────────────────────────────────

const LEVEL_CONFIG: Record<string, {
  color: string; label: string; bg: string; border: string;
}> = {
  LOW:      { color: "var(--green)",   label: "Low Risk",      bg: "var(--green-dim)",   border: "var(--green-border)"   },
  MEDIUM:   { color: "var(--warning)", label: "Medium Risk",   bg: "var(--warning-dim)", border: "var(--warning-border)" },
  HIGH:     { color: "var(--warning)", label: "High Risk",     bg: "var(--warning-dim)", border: "var(--warning-border)" },
  CRITICAL: { color: "var(--red)",     label: "Critical Risk", bg: "var(--red-dim)",     border: "var(--red-border)"     },
};

const PROVIDER_LABELS: Record<string, string> = {
  samsara: "Samsara",
  motive:  "Motive",
  geotab:  "Geotab",
};

function formatEventType(type: string): string {
  return type.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Map a recommendation string → icon + title
const ICON_PROPS = { size: 16, strokeWidth: 1.75 };

function parseRecommendation(rec: string): {
  icon: React.ReactNode;
  title: string;
  description: string;
} {
  const lower = rec.toLowerCase();
  if (lower.includes("rest") || lower.includes("break") || lower.includes("fatigue")) {
    return { icon: <Moon {...ICON_PROPS} />, title: "Fatigue", description: rec };
  }
  if (lower.includes("weather") || lower.includes("caution") || lower.includes("condition")) {
    return { icon: <Cloud {...ICON_PROPS} />, title: "Weather", description: rec };
  }
  if (lower.includes("speed") || lower.includes("following distance")) {
    return { icon: <Gauge {...ICON_PROPS} />, title: "Speed", description: rec };
  }
  if (lower.includes("zone") || lower.includes("area")) {
    return { icon: <MapPin {...ICON_PROPS} />, title: "Zone Alert", description: rec };
  }
  if (lower.includes("phone") || lower.includes("distract")) {
    return { icon: <Smartphone {...ICON_PROPS} />, title: "Distraction", description: rec };
  }
  if (lower.includes("brake") || lower.includes("stop")) {
    return { icon: <AlertTriangle {...ICON_PROPS} />, title: "Braking", description: rec };
  }
  if (lower.includes("pull over") || lower.includes("power loss") || lower.includes("inspect")) {
    return { icon: <Wrench {...ICON_PROPS} />, title: "Vehicle", description: rec };
  }
  if (lower.includes("smooth") || lower.includes("accel") || lower.includes("maneuver")) {
    return { icon: <Gauge {...ICON_PROPS} />, title: "Driving Style", description: rec };
  }
  return { icon: <Info {...ICON_PROPS} />, title: "Advisory", description: rec };
}

// ── Skeleton loading block ─────────────────────────────────────────────────────
function SkeletonBlock({ height, radius = 12 }: { height: number; radius?: number }) {
  return (
    <div className="skeleton" style={{ height, borderRadius: radius }} />
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function DashboardScreen({ onIncident }: { onIncident: () => void }) {
  const telegramUser = useTelegram();

  const [riskData,         setRiskData]         = useState<RiskResponse | null>(null);
  const [location,         setLocation]         = useState<DriverLocation | null>(null);
  const [loading,          setLoading]          = useState(true);
  const [error,            setError]            = useState<string | null>(null);
  const [driverId,         setDriverId]         = useState<string | null>(null);
  const [showIncidentForm, setShowIncidentForm] = useState(false);
  const [incidentText,     setIncidentText]     = useState("");
  const [submitting,       setSubmitting]       = useState(false);

  // ── Data loading (unchanged) ─────────────────────────────────────────────────
  useEffect(() => {
    if (!telegramUser) return;
    let cancelled = false;

    async function loadRisk() {
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
        if (!cancelled) setDriverId(driver.id);

        const [riskRes, locationRes] = await Promise.all([
          fetch(`/api/risk?driverId=${driver.id}`),
          fetch(`/api/location?driverId=${driver.id}`),
        ]);
        if (!riskRes.ok) throw new Error(`Risk API failed: ${riskRes.status}`);
        const riskData: RiskResponse = await riskRes.json();

        if (!cancelled) {
          setRiskData(riskData);
          if (locationRes.ok) setLocation(await locationRes.json());
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message ?? "Failed to load risk data");
          setLoading(false);
        }
      }
    }

    loadRisk();
    return () => { cancelled = true; };
  }, [telegramUser]);

  // ── Incident submission (unchanged) ──────────────────────────────────────────
  async function submitIncident() {
    if (!driverId) return;
    setSubmitting(true);
    try {
      await fetch("/api/incident", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId,
          description: incidentText.trim() || null,
          location: location?.locationLabel ?? null,
        }),
      });
      setShowIncidentForm(false);
      setIncidentText("");
      onIncident();
    } finally {
      setSubmitting(false);
    }
  }

  const result      = riskData?.result;
  const levelConfig = result ? (LEVEL_CONFIG[result.level] ?? LEVEL_CONFIG.HIGH) : null;
  const parsedRecs  = result?.recommendations.map(parseRecommendation) ?? [];

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in flex flex-col" style={{ gap: 24, padding: "24px 20px 8px" }}>

      {/* ── 1. Greeting ─────────────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 24, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.5px", lineHeight: 1.2 }}>
          {getGreeting()}{telegramUser?.firstName ? `, ${telegramUser.firstName}` : ""}.
        </div>
        <div style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 4 }}>
          Drive safely today.
        </div>
      </div>

      {/* ── 2. Risk Card ────────────────────────────────────────────────────── */}
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 20,
          padding: "24px",
        }}
      >
        {/* Header label */}
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.6px", textTransform: "uppercase", marginBottom: 16 }}>
          Real-time predictive risk
        </div>

        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <SkeletonBlock height={72} radius={12} />
            <SkeletonBlock height={16} radius={8} />
            <SkeletonBlock height={48} radius={8} />
          </div>
        )}

        {error && (
          <div style={{ fontSize: 13, color: "var(--red)", textAlign: "center", padding: "12px 0" }}>
            Failed to load risk data. Please try again.
          </div>
        )}

        {result && levelConfig && (
          <>
            {/* Score + badge row */}
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 8 }}>
              <div
                style={{
                  fontSize: 72,
                  fontWeight: 700,
                  color: levelConfig.color,
                  letterSpacing: "-3px",
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                  fontFamily: "Inter, system-ui, sans-serif",
                }}
              >
                {result.score}
              </div>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: levelConfig.bg,
                  border: `1px solid ${levelConfig.border}`,
                  borderRadius: 99,
                  padding: "5px 12px",
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: levelConfig.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 11, fontWeight: 600, color: levelConfig.color, letterSpacing: "0.4px", textTransform: "uppercase" }}>
                  {levelConfig.label}
                </span>
              </div>
            </div>

            {/* Risk factors */}
            {result.factors.length > 0 && (
              <>
                <div style={{ height: 1, background: "var(--border)", margin: "20px 0 16px" }} />
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.6px", textTransform: "uppercase", marginBottom: 14 }}>
                  Primary risk factors
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {result.factors.slice(0, 3).map((f) => (
                    <div key={f.name}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{f.name}</span>
                        <span style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "JetBrains Mono, monospace" }}>{f.impact}%</span>
                      </div>
                      <div style={{ height: 3, borderRadius: 99, background: "var(--border)", overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${f.impact}%`,
                            borderRadius: 99,
                            background: levelConfig.color,
                            transition: "width 0.9s cubic-bezier(0.4,0,0.2,1)",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Live data footer */}
            {riskData && (
              <div
                style={{
                  marginTop: 20,
                  paddingTop: 16,
                  borderTop: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                {riskData.dataSource === "real" && riskData.liveData ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div className="dot-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 500, color: "var(--green)" }}>
                      Live · {PROVIDER_LABELS[riskData.liveData.provider] ?? riskData.liveData.provider}
                    </span>
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Demo mode</span>
                )}
                {riskData.dataSource === "real" && riskData.liveData && riskData.liveData.driverEventCount24h > 0 && (
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {riskData.liveData.driverEventCount24h} event{riskData.liveData.driverEventCount24h !== 1 ? "s" : ""} · 24h
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Live data detail row — only for real pilot data */}
      {riskData?.dataSource === "real" && riskData.liveData && riskData.liveData.lastEventType && (
        <div
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: "14px 18px",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "10px 16px",
          }}
        >
          {[
            ["Last event",   formatEventType(riskData.liveData.lastEventType)],
            ["Event time",   riskData.liveData.lastEventTimestamp ? formatTs(riskData.liveData.lastEventTimestamp) : "—"],
            ["Last sync",    riskData.liveData.lastSyncTime ? formatTs(riskData.liveData.lastSyncTime) : "—"],
            ["Events (24h)", String(riskData.liveData.driverEventCount24h)],
          ].map(([label, value]) => (
            <div key={label}>
              <div style={{ fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>
                {label}
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── 3. Incident Protocol ─────────────────────────────────────────────── */}
      <div>
        <button
          onClick={() => driverId ? setShowIncidentForm(true) : onIncident()}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            background: "rgba(255, 74, 74, 0.06)",
            border: "1px solid rgba(255, 74, 74, 0.28)",
            borderRadius: 16,
            padding: "17px 24px",
            color: "var(--red)",
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: "0.2px",
            cursor: "pointer",
            transition: "background 0.15s ease",
          }}
        >
          <TriangleAlert size={18} strokeWidth={1.75} />
          Initiate Incident Protocol
        </button>

        {showIncidentForm && (
          <div
            style={{
              marginTop: 12,
              background: "var(--card)",
              border: "1px solid var(--red-border)",
              borderRadius: 16,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 10 }}>
              Incident description
            </div>
            <textarea
              value={incidentText}
              onChange={(e) => setIncidentText(e.target.value)}
              placeholder="Briefly describe what happened..."
              rows={3}
              style={{
                width: "100%",
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "10px 14px",
                fontSize: 14,
                color: "var(--text-primary)",
                resize: "none",
                outline: "none",
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button
                onClick={submitIncident}
                disabled={submitting}
                style={{
                  flex: 1,
                  padding: "11px 0",
                  borderRadius: 12,
                  border: "none",
                  background: "var(--red)",
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: submitting ? "not-allowed" : "pointer",
                  opacity: submitting ? 0.6 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                {submitting ? "Submitting..." : "Submit report"}
              </button>
              <button
                onClick={() => { setShowIncidentForm(false); setIncidentText(""); }}
                style={{
                  padding: "11px 18px",
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── 4. Today's Summary ───────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12, letterSpacing: "0.2px" }}>
          Today&apos;s Summary
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {[
            {
              value: loading ? "—" : (location ? String(location.checksPassed) : "—"),
              color: "var(--green)",
              label: "Checks\npassed",
            },
            {
              value: loading ? "—" : (location ? String(location.milesDriven) : "—"),
              color: "var(--blue)",
              label: "Miles\ndriven",
            },
            {
              value: loading ? "—" : (riskData ? String(riskData.input.safetyEvents.length) : "—"),
              color: riskData && riskData.input.safetyEvents.length > 0 ? "var(--warning)" : "var(--text-secondary)",
              label: "Alerts\nactive",
            },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 16,
                padding: "14px 12px",
              }}
            >
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  color: s.color,
                  letterSpacing: "-0.5px",
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                }}
              >
                {s.value}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginTop: 6,
                  lineHeight: 1.35,
                  whiteSpace: "pre-line",
                }}
              >
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 5. Recommendations ───────────────────────────────────────────────── */}
      {parsedRecs.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12, letterSpacing: "0.2px" }}>
            Recommendations
          </div>
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 20,
              overflow: "hidden",
            }}
          >
            {parsedRecs.map((rec, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "14px 16px",
                  borderBottom: i < parsedRecs.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                {/* Icon chip */}
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    color: "var(--blue)",
                  }}
                >
                  {rec.icon}
                </div>

                {/* Text */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)", marginBottom: 2 }}>
                    {rec.title}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.4 }}>
                    {rec.description}
                  </div>
                </div>

                {/* Chevron */}
                <ChevronRight size={16} strokeWidth={1.75} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

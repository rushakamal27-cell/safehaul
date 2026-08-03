"use client";

import { useEffect, useState } from "react";
import { RiskInput, RiskOutput } from "@/lib/riskEngine";
import type { ContextSources, ContextStatus, HosDetail } from "@/lib/driverContext/types";
import { useTelegram } from "@/lib/useTelegram";
import { resolveDisplayName } from "@/lib/driverIdentity";
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

interface TodaySummary {
  checksPassed: number;
  milesDriven: number | null;
  alertsActive: number;
  timezone: string;
  dataStatus: {
    checks: "available" | "unavailable";
    mileage: "available" | "unavailable";
    alerts: "available" | "unavailable";
  };
}

interface RiskResponse {
  driverId: string;
  timestamp: string;
  // Connection path (pilot provider vs. demo) — kept for backward
  // compatibility. Use contextStatus for "is this score actually live".
  dataSource: "real" | "mock";
  contextStatus: ContextStatus;
  contextSources: ContextSources;
  liveData: LiveData | null;
  hos: HosDetail;
  todaySummary: TodaySummary;
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

// Covers both liveData.provider (a raw provider id string, e.g. "samsara")
// and ContextSources' per-field provider (which also includes the
// non-telematics providers below) — one shared label map for both uses.
const PROVIDER_LABELS: Record<string, string> = {
  samsara:            "Samsara",
  motive:             "Motive",
  geotab:             "Geotab",
  openweather:        "OpenWeatherMap",
  internal_geofence:  "SafeHaul Zones",
  internal:           "Demo",
};

const CONTEXT_STATUS_CONFIG: Record<ContextStatus, { color: string; statusLabel: string }> = {
  full_live:    { color: "var(--green)",         statusLabel: "Fully live"     },
  partial_live: { color: "var(--warning)",       statusLabel: "Partially live" },
  demo:         { color: "var(--text-tertiary)", statusLabel: "Public Demo"    },
};

type FieldMeta = ContextSources[keyof ContextSources];
type SpecialFieldStatus = "live" | "cached" | "unavailable" | "fallback";

/**
 * Classifies a field for wording purposes. "cached" is real data that isn't
 * confirmed-fresh this call — it must never read as "live" to a driver.
 * "fallback" covers both a genuine substitution (a real API call failed) and
 * a field with no real source integrated yet — those two cases share a
 * state in the data model and both render as "Demo Data" below, since
 * either way the number on screen did not come from a live provider call.
 */
function classifySpecial(meta: FieldMeta): SpecialFieldStatus {
  if (meta.state === "unavailable") return "unavailable";
  if (meta.origin === "observed" || meta.origin === "estimated") {
    return meta.state === "fresh" ? "live" : "cached";
  }
  return "fallback";
}

function providerLabel(provider: FieldMeta["provider"]): string | null {
  if (!provider) return null;
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Whole minutes between an ISO timestamp and now; null if unparseable/absent/in the future (never shown as "-1 min old"). */
function minutesAgo(observedAt: string | null, now: Date): number | null {
  if (!observedAt) return null;
  const ms = now.getTime() - new Date(observedAt).getTime();
  if (!isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60_000);
}

/**
 * One consistent phrase per field, covering all four states the same way
 * for every field — no field gets bespoke wording or generic-only grouping
 * (Phase 5: previously safetyEvents/weather/hos had individually tailored
 * sentences while speed/zoneRisk were only ever grouped generically, which
 * meant the two groups could describe an identically-shaped real/live
 * reading in different words). "Live"/"Cached" name the provider; "Cached"
 * additionally reports how old the reading is when that's computable.
 */
function fieldStatusPhrase(label: string, meta: FieldMeta, now: Date): string {
  const provider = providerLabel(meta.provider);
  switch (classifySpecial(meta)) {
    case "live":
      return provider ? `${label}: Live (${provider}).` : `${label}: Live.`;
    case "cached": {
      const mins = minutesAgo(meta.observedAt, now);
      const age = mins !== null ? `, ${mins} min old` : "";
      return provider ? `${label}: Cached (${provider}${age}).` : `${label}: Cached${age ? ` (${mins} min old)` : ""}.`;
    }
    case "unavailable":
      return `${label}: Unavailable.`;
    case "fallback":
      return `${label}: Demo Data.`;
  }
}

const DISCLOSURE_FIELDS: { key: keyof ContextSources; label: string }[] = [
  { key: "safetyEvents", label: "Safety events" },
  { key: "hos",          label: "HOS" },
  { key: "speed",        label: "Speed" },
  { key: "weather",      label: "Weather" },
  { key: "zoneRisk",     label: "Zone risk" },
];

/**
 * Builds the "what's live vs. cached vs. unavailable vs. demo" disclosure
 * shown for partial_live — generated entirely from contextSources, never
 * hardcoded, and every field goes through the exact same fieldStatusPhrase
 * so none can read more or less "live" than its actual contextSources state
 * says it is.
 */
function buildPartialLiveDisclosure(sources: ContextSources): string {
  const now = new Date();
  return DISCLOSURE_FIELDS
    .map(({ key, label }) => fieldStatusPhrase(label, sources[key], now))
    .join(" ");
}

/** "A, B and C" — small local join, same shape as the joinWithAnd() helper Phase 5 removed elsewhere, kept minimal since missingContext never exceeds 3 items (weather/zone/HOS). */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** +40% / -10% / +0% — signed whole-percent display for a contextual speed modifier. */
function formatModifierPercent(modifier: number): string {
  const pct = Math.round(modifier * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

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
  const [canonicalName,    setCanonicalName]    = useState<string | null>(null);
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
            lastName: telegramUser!.lastName,
            username: telegramUser!.username,
          }),
        });
        if (!driverRes.ok) throw new Error(`Driver API failed: ${driverRes.status}`);
        const { driver } = await driverRes.json();
        if (!cancelled) {
          setDriverId(driver.id);
          setCanonicalName(driver.canonicalName ?? null);
        }

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

  // Preferred order: canonicalName (real operational identity) > Telegram
  // first+last > Telegram username > generic fallback. See lib/driverIdentity.ts.
  const displayName = telegramUser
    ? resolveDisplayName({
        canonicalName,
        telegramFirstName: telegramUser.firstName,
        telegramLastName:  telegramUser.lastName,
        telegramUsername:  telegramUser.username,
      })
    : null;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in flex flex-col" style={{ gap: 24, padding: "24px 20px 8px" }}>

      {/* ── 1. Greeting ─────────────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 24, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.5px", lineHeight: 1.2 }}>
          {getGreeting()}{displayName ? `, ${displayName}` : ""}.
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
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  {riskData.contextStatus !== "demo" && riskData.liveData ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div
                        className="dot-pulse"
                        style={{ width: 6, height: 6, borderRadius: "50%", background: CONTEXT_STATUS_CONFIG[riskData.contextStatus].color, flexShrink: 0 }}
                      />
                      <span style={{ fontSize: 12, fontWeight: 500, color: CONTEXT_STATUS_CONFIG[riskData.contextStatus].color }}>
                        {riskData.contextStatus === "full_live"
                          ? `${CONTEXT_STATUS_CONFIG.full_live.statusLabel} (${PROVIDER_LABELS[riskData.liveData.provider] ?? riskData.liveData.provider})`
                          : CONTEXT_STATUS_CONFIG.partial_live.statusLabel}
                      </span>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{CONTEXT_STATUS_CONFIG.demo.statusLabel}</span>
                  )}
                  {riskData.contextStatus !== "demo" && riskData.liveData && riskData.liveData.driverEventCount24h > 0 && (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {riskData.liveData.driverEventCount24h} event{riskData.liveData.driverEventCount24h !== 1 ? "s" : ""} · 24h
                    </span>
                  )}
                </div>
                {riskData.contextStatus === "partial_live" && (
                  <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 8, lineHeight: 1.4 }}>
                    {buildPartialLiveDisclosure(riskData.contextSources)}
                    {/* Demo accounts only (dataSource "mock") — appended, never replacing the
                        per-field technical breakdown above. Real pilot drivers on a partial_live
                        connection (dataSource "real") see the breakdown exactly as before. */}
                    {riskData.dataSource === "mock" && " This account uses simulated driving data for demonstration. Connected fleet drivers receive real telematics data."}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Live data detail row — only for pilot data (full_live or partial_live) */}
      {riskData && riskData.contextStatus !== "demo" && riskData.liveData && riskData.liveData.lastEventType && (
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
            ["Provider",     PROVIDER_LABELS[riskData.liveData.provider] ?? riskData.liveData.provider],
            ["Data status",  CONTEXT_STATUS_CONFIG[riskData.contextStatus].statusLabel],
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

      {/* Contextual Speed breakdown (Phase 4.5, continuous-exposure refinement)
          — only when there's an actual speed exposure to explain (a
          continuous, no-cliff signal — see calculateSpeedExposure in
          lib/riskEngine.ts; this is no longer "only above 70 mph").
          Modifiers for unavailable inputs are never shown (see `included`
          on each component), and missing context is disclosed in plain
          driver-facing language rather than field names like
          "hosAvailable". */}
      {result && result.contextualSpeed.active && (
        <div
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: "16px 18px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", letterSpacing: "0.2px" }}>
              Contextual Speed
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
              {result.contextualSpeed.finalPenalty.toFixed(1)} pts
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
              <span style={{ color: "var(--text-secondary)" }}>Speed exposure</span>
              <span style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{result.contextualSpeed.speedExposure.toFixed(1)}</span>
            </div>
            {result.contextualSpeed.components
              .filter((c) => c.included && c.modifier > 0)
              .map((c) => (
                <div key={c.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span style={{ color: "var(--text-secondary)" }}>{c.label} amplification</span>
                  <span style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{formatModifierPercent(c.modifier)}</span>
                </div>
              ))}
          </div>
          {!result.contextualSpeed.contextComplete && (
            <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              Context incomplete: {joinList(result.contextualSpeed.missingContext)} data unavailable.
            </div>
          )}
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
              value: loading ? "—" : (riskData && riskData.todaySummary.dataStatus.checks === "available"
                ? String(riskData.todaySummary.checksPassed) : "—"),
              color: "var(--green)",
              label: "Checks\npassed",
            },
            {
              value: loading ? "—" : (riskData && riskData.todaySummary.dataStatus.mileage === "available" && riskData.todaySummary.milesDriven !== null
                ? String(riskData.todaySummary.milesDriven) : "—"),
              color: "var(--blue)",
              label: "Miles\ndriven",
            },
            {
              value: loading ? "—" : (riskData && riskData.todaySummary.dataStatus.alerts === "available"
                ? String(riskData.todaySummary.alertsActive) : "—"),
              color: riskData && riskData.todaySummary.alertsActive > 0 ? "var(--warning)" : "var(--text-secondary)",
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

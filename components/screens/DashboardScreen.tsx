"use client";
import { useEffect, useState } from "react";
import { RiskOutput } from "@/lib/riskEngine";
import { useTelegram } from "@/lib/useTelegram";

interface RiskResponse {
  driverId: string;
  timestamp: string;
  result: RiskOutput;
}

const LEVEL_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  LOW:      { color: "var(--green)",  bg: "rgba(0,232,122,0.1)",  border: "rgba(0,232,122,0.3)"  },
  MEDIUM:   { color: "var(--yellow)", bg: "rgba(255,214,0,0.1)",  border: "rgba(255,214,0,0.3)"  },
  HIGH:     { color: "var(--orange)", bg: "rgba(255,140,0,0.1)",  border: "rgba(255,140,0,0.3)"  },
  CRITICAL: { color: "var(--red)",    bg: "rgba(255,60,60,0.1)",  border: "rgba(255,60,60,0.3)"  },
};

export function DashboardScreen({ onIncident }: { onIncident: () => void }) {
  const telegramUser = useTelegram();

  const [riskData, setRiskData] = useState<RiskResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    // Wait until Telegram identity is resolved
    if (!telegramUser) return;

    let cancelled = false;

    async function loadRisk() {
      try {
        // Step 1: resolve or create driver via telegramUserId
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

        // Step 2: fetch risk score using the real database driver ID
        const riskRes = await fetch(`/api/risk?driverId=${driver.id}`);
        if (!riskRes.ok) throw new Error(`Risk API failed: ${riskRes.status}`);
        const riskData: RiskResponse = await riskRes.json();

        if (!cancelled) {
          setRiskData(riskData);
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

  const result = riskData?.result;
  const levelStyle = result ? (LEVEL_STYLES[result.level] ?? LEVEL_STYLES.HIGH) : null;

  return (
    <div className="animate-fade-in">
      {/* ── Real-Time Predictive Risk Card ── */}
      <p className="font-mono text-[10px] tracking-[2px] uppercase mb-[10px]" style={{ color: "var(--text-secondary)" }}>
        Real-Time Predictive Risk
      </p>
      <div
        className="flex flex-col items-center rounded-2xl p-6 mb-4 relative overflow-hidden"
        style={{
          background: "linear-gradient(145deg,var(--bg-panel),var(--bg-card))",
          border: `1px solid ${levelStyle?.border ?? "var(--border-bright)"}`,
        }}
      >
        <div className="absolute top-0 left-0 right-0 h-[2px]" style={{ background: "linear-gradient(90deg,transparent,var(--cyan),transparent)" }} />
        <p className="font-mono text-[10px] tracking-[3px] mb-4" style={{ color: "var(--text-secondary)" }}>
          PREDICTIVE RISK ENGINE · LIVE
        </p>

        {loading && (
          <div className="w-full flex flex-col items-center gap-3 py-4">
            <div className="w-[72px] h-[72px] rounded-full animate-pulse" style={{ background: "var(--bg-card)", border: "1px solid var(--border-bright)" }} />
            <div className="w-32 h-3 rounded animate-pulse" style={{ background: "var(--bg-card)" }} />
            <div className="w-24 h-3 rounded animate-pulse" style={{ background: "var(--bg-card)" }} />
          </div>
        )}

        {error && (
          <p className="font-mono text-[11px] text-center py-4" style={{ color: "var(--red)" }}>
            Failed to load risk data
          </p>
        )}

        {result && levelStyle && (
          <>
            {/* Score */}
            <div className="font-display font-black text-[64px] leading-none mb-1" style={{ color: levelStyle.color, textShadow: `0 0 24px ${levelStyle.color}` }}>
              {result.score}
            </div>

            {/* Level badge */}
            <span
              className="font-mono text-[11px] tracking-[3px] px-3 py-[4px] rounded-full mb-5"
              style={{ color: levelStyle.color, background: levelStyle.bg, border: `1px solid ${levelStyle.border}` }}
            >
              ● {result.level}
            </span>

            {/* Top Risk Drivers */}
            {result.factors.length > 0 && (
              <div className="w-full mb-4">
                <p className="font-mono text-[9px] tracking-[2px] uppercase mb-2" style={{ color: "var(--text-secondary)" }}>
                  Top Risk Drivers
                </p>
                <div className="flex flex-col gap-[6px]">
                  {result.factors.slice(0, 3).map((f) => (
                    <div key={f.name} className="flex items-center gap-2">
                      <span className="font-mono text-[11px] flex-1" style={{ color: "var(--text-primary)" }}>{f.name}</span>
                      <div className="flex-1 h-[4px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}>
                        <div className="h-full rounded-full" style={{ width: `${f.impact}%`, background: levelStyle.color, opacity: 0.85 }} />
                      </div>
                      <span className="font-mono text-[11px] w-[34px] text-right" style={{ color: levelStyle.color }}>{f.impact}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recommended Actions */}
            {result.recommendations.length > 0 && (
              <div className="w-full">
                <p className="font-mono text-[9px] tracking-[2px] uppercase mb-2" style={{ color: "var(--text-secondary)" }}>
                  Recommended Actions
                </p>
                <div className="flex flex-col gap-[6px]">
                  {result.recommendations.slice(0, 3).map((rec) => (
                    <div key={rec} className="flex items-start gap-2 rounded-lg px-3 py-[8px]" style={{ background: "rgba(0,200,255,0.05)", border: "1px solid rgba(0,200,255,0.12)" }}>
                      <span style={{ color: "var(--cyan)" }}>›</span>
                      <span className="text-[12px] leading-snug" style={{ color: "var(--text-primary)" }}>{rec}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Active Operational Zone (unchanged) ── */}
      <p className="font-mono text-[10px] tracking-[2px] uppercase mb-[10px]" style={{ color: "var(--text-secondary)" }}>Active Operational Zone</p>
      <div className="rounded-2xl p-[14px_16px] mb-4 relative overflow-hidden" style={{ background: "linear-gradient(135deg,#0d1a24,#0a1520)", border: "1px solid rgba(255,140,0,0.3)" }}>
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full dot-pulse" style={{ background: "var(--orange)", boxShadow: "0 0 8px var(--orange)" }} />
          <span className="font-mono text-[10px] tracking-[2px]" style={{ color: "var(--orange)" }}>ENTERING ZONE · GEO-FENCED</span>
        </div>
        <div className="font-display font-bold text-[15px] mb-[6px]" style={{ color: "var(--text-primary)" }}>Port of Savannah — Terminal Gate 7</div>
        <div className="flex flex-wrap gap-[6px]">
          {["⚠ HIGH PEDESTRIAN TRAFFIC", "🔍 INSPECTION LVL 8", "📡 V2X ACTIVE", "5 MPH LIMIT"].map((tag) => (
            <span key={tag} className="font-mono text-[10px] px-2 py-[3px] rounded-[4px]" style={{ background: "rgba(255,140,0,0.1)", color: "var(--orange)", border: "1px solid rgba(255,140,0,0.25)" }}>{tag}</span>
          ))}
        </div>
      </div>

      {/* ── Incident Protocol (unchanged) ── */}
      <button
        onClick={onIncident}
        className="w-full p-[18px] rounded-2xl mb-4 relative overflow-hidden flex items-center justify-center gap-[10px] font-display font-black text-[17px] tracking-[3px] uppercase cursor-pointer incident-hatch"
        style={{ background: "linear-gradient(135deg,#3a0808,#250505)", border: "2px solid var(--red)", color: "var(--red)", boxShadow: "0 0 20px rgba(255,60,60,0.2)" }}
      >
        <span className="text-[22px]">⚡</span>INITIATE INCIDENT PROTOCOL
      </button>

      {/* ── Today's Summary (unchanged) ── */}
      <p className="font-mono text-[10px] tracking-[2px] uppercase mb-[10px]" style={{ color: "var(--text-secondary)" }}>Today&apos;s Summary</p>
      <div className="grid grid-cols-3 gap-[10px]">
        {[
          { val: "4",   color: "var(--green)",  label: "CHECKS\nPASSED"  },
          { val: "312", color: "var(--cyan)",   label: "MILES\nDRIVEN"   },
          { val: "1",   color: "var(--orange)", label: "ALERTS\nACTIVE"  },
        ].map((s) => (
          <div key={s.label} className="rounded-xl p-[12px_10px] text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--border))" }}>
            <div className="font-display font-bold text-[22px]" style={{ color: s.color }}>{s.val}</div>
            <div className="font-mono text-[9px] tracking-[1px] mt-[3px] whitespace-pre-line" style={{ color: "var(--text-secondary)" }}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

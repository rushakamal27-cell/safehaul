"use client";

import { useRef, useState } from "react";
import { useTelegram } from "@/lib/useTelegram";
import type { CheckItem, InspectionResult } from "@/lib/inspection";
import { Camera, CheckCircle2, AlertTriangle, XCircle, ChevronRight } from "lucide-react";

// ── Image compression (unchanged) ─────────────────────────────────────────────
async function compressImage(file: File, maxWidth = 800, quality = 0.75): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const ratio  = Math.min(maxWidth / img.width, 1);
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Canvas toBlob failed"))),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}

// ── Design helpers ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { bg: string; color: string; border: string; icon: React.ReactNode }> = {
  PASS: {
    bg: "var(--green-dim)", color: "var(--green)", border: "var(--green-border)",
    icon: <CheckCircle2 size={14} strokeWidth={1.75} />,
  },
  WARN: {
    bg: "var(--warning-dim)", color: "var(--warning)", border: "var(--warning-border)",
    icon: <AlertTriangle size={14} strokeWidth={1.75} />,
  },
  FAIL: {
    bg: "var(--red-dim)", color: "var(--red)", border: "var(--red-border)",
    icon: <XCircle size={14} strokeWidth={1.75} />,
  },
};

const ITEM_ICONS: Record<string, string> = {
  Tires:       "🛞",
  Brakes:      "🔴",
  Lights:      "💡",
  Windshield:  "🪟",
  "Engine Bay":"⚙️",
};

const OVERALL_LABEL: Record<string, string> = {
  PASS: "Passed",
  WARN: "Warning",
  FAIL: "Failed",
};

// ── Types ──────────────────────────────────────────────────────────────────────
type ScreenState = "idle" | "uploading" | "results";

interface InspectionResponse extends InspectionResult {
  id: string;
  signedPhotoUrl: string;
}

// ── Check item — iOS Settings row style ────────────────────────────────────────
function CheckItemRow({ item, showDivider, animate }: { item: CheckItem; showDivider: boolean; animate?: boolean }) {
  const cfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.WARN;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px" }}>
        <span style={{ fontSize: 20, flexShrink: 0 }}>{ITEM_ICONS[item.name] ?? "🔍"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>{item.name}</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.4 }}>{item.detail}</div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            background: cfg.bg,
            border: `1px solid ${cfg.border}`,
            borderRadius: 99,
            padding: "3px 10px",
            color: cfg.color,
            fontSize: 11,
            fontWeight: 600,
            flexShrink: 0,
          }}
          className={animate && item.status === "FAIL" ? "status-blink" : ""}
        >
          {cfg.icon}
          <span>{item.status}</span>
        </div>
      </div>
      {showDivider && (
        <div style={{ height: 1, background: "var(--border)", marginLeft: 52 }} />
      )}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export function InspectScreen() {
  const telegramUser = useTelegram();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [state,  setState]  = useState<ScreenState>("idle");
  const [result, setResult] = useState<InspectionResponse | null>(null);
  const [error,  setError]  = useState<string | null>(null);

  // ── File handling (unchanged) ────────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file || !telegramUser) return;

    setError(null);
    setState("uploading");

    try {
      const driverRes = await fetch("/api/driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramUserId: telegramUser.id, name: telegramUser.firstName }),
      });
      if (!driverRes.ok) throw new Error("Could not resolve driver");
      const { driver } = await driverRes.json();

      const compressed = await compressImage(file);

      const form = new FormData();
      form.append("driverId", driver.id);
      form.append("photo", compressed, "inspection.jpg");

      const inspectRes = await fetch("/api/inspect", { method: "POST", body: form });
      if (!inspectRes.ok) {
        const body = await inspectRes.json().catch(() => ({}));
        throw new Error(body.error ?? `Server error ${inspectRes.status}`);
      }
      const data: InspectionResponse = await inspectRes.json();
      setResult(data);
      setState("results");
    } catch (err: any) {
      setError(err.message ?? "Inspection failed");
      setState("idle");
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function reset() {
    setResult(null);
    setError(null);
    setState("idle");
  }

  const overallCfg = result ? (STATUS_CONFIG[result.overallResult] ?? STATUS_CONFIG.WARN) : null;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in" style={{ padding: "24px 20px 8px", display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Page header */}
      <div>
        <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.4px" }}>
          Vehicle Inspection
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          AI-powered pre-trip analysis
        </div>
      </div>

      {/* ── AR Viewport ─────────────────────────────────────────────────────── */}
      <div
        style={{
          borderRadius: 20,
          overflow: "hidden",
          height: 240,
          background: "#040e0a",
          border: `1px solid ${overallCfg?.border ?? "var(--border)"}`,
          position: "relative",
        }}
      >
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          {/* Background emoji */}
          <span style={{ fontSize: 80, opacity: 0.12 }}>🚛</span>

          {/* Corner reticles */}
          <div className="reticle-tl" />
          <div className="reticle-tr" />
          <div className="reticle-bl" />
          <div className="reticle-br" />

          {/* Scan animation */}
          {state === "uploading" && <div className="ar-scan-line" />}

          {/* Status chip */}
          <div
            style={{
              position: "absolute",
              top: 14,
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(0,0,0,0.72)",
              border: `1px solid ${state === "results" ? overallCfg!.border : "var(--green-border)"}`,
              borderRadius: 99,
              padding: "5px 14px",
              color: state === "results" ? overallCfg!.color : "var(--green)",
              fontSize: 11,
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: state === "results" ? overallCfg!.color : "var(--green)",
                flexShrink: 0,
              }}
              className={state === "uploading" ? "dot-pulse" : ""}
            />
            {state === "idle"      && "Ready to scan"}
            {state === "uploading" && "Analyzing vehicle..."}
            {state === "results"   && `${OVERALL_LABEL[result!.overallResult]} — ${Math.round(result!.confidence * 100)}% confidence`}
          </div>

          {/* Result bounding-box overlays */}
          {state === "results" && result && (() => {
            const positions = [
              { left: "12%", top: "55%", w: "22%", h: "28%" },
              { left: "65%", top: "52%", w: "24%", h: "30%" },
              { left: "38%", top: "30%", w: "26%", h: "22%" },
              { left: "12%", top: "22%", w: "22%", h: "22%" },
              { left: "65%", top: "22%", w: "24%", h: "22%" },
            ];
            return result.checkItems.map((item, i) => {
              const s = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.WARN;
              const p = positions[i] ?? positions[0];
              return (
                <div
                  key={item.name}
                  className="bbox-anim"
                  style={{
                    position: "absolute",
                    left: p.left, top: p.top, width: p.w, height: p.h,
                    border: `1.5px solid ${s.color}`,
                    borderRadius: 6,
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: -20,
                      left: -1,
                      fontSize: 9,
                      fontWeight: 600,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: s.color,
                      color: item.status === "PASS" || item.status === "WARN" ? "#000" : "#fff",
                      letterSpacing: "0.3px",
                    }}
                  >
                    {item.name.toUpperCase()}
                  </span>
                </div>
              );
            });
          })()}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ fontSize: 13, color: "var(--red)", textAlign: "center" }}>
          {error}
        </div>
      )}

      {/* ── Primary action button ─────────────────────────────────────────────── */}
      {state !== "results" && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={state === "uploading" || !telegramUser}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: "16px 24px",
              borderRadius: 16,
              border: state === "uploading"
                ? "1px solid var(--border)"
                : "1px solid var(--blue-border)",
              background: state === "uploading"
                ? "var(--bg-secondary)"
                : "var(--blue-dim)",
              color: state === "uploading" ? "var(--text-tertiary)" : "var(--blue)",
              fontSize: 15,
              fontWeight: 600,
              cursor: state === "uploading" ? "not-allowed" : "pointer",
              transition: "all 0.15s ease",
            }}
          >
            <Camera size={18} strokeWidth={1.75} />
            {state === "uploading" ? "Analyzing vehicle..." : "Start Inspection"}
          </button>
        </>
      )}

      {/* ── Idle placeholder ─────────────────────────────────────────────────── */}
      {state === "idle" && (
        <div
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: "20px 16px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}>
            No recent inspections
          </div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
            Tap Start Inspection to photograph your vehicle.
            The AI will check tires, brakes, lights, windshield, and engine bay.
          </div>
        </div>
      )}

      {/* ── Check items (skeleton during analysis) ───────────────────────────── */}
      {state === "uploading" && (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 20, overflow: "hidden" }}>
          {[1, 2, 3, 4, 5].map((_, i) => (
            <div key={i}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px" }}>
                <div className="skeleton" style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0 }} />
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div className="skeleton" style={{ height: 13, width: "40%" }} />
                  <div className="skeleton" style={{ height: 11, width: "70%" }} />
                </div>
                <div className="skeleton" style={{ width: 52, height: 22, borderRadius: 99 }} />
              </div>
              {i < 4 && <div style={{ height: 1, background: "var(--border)", marginLeft: 52 }} />}
            </div>
          ))}
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────────────── */}
      {state === "results" && result && (
        <>
          {/* Check items list */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12, letterSpacing: "0.2px" }}>
              Inspection Checklist
            </div>
            <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 20, overflow: "hidden" }}>
              {result.checkItems.map((item, i) => (
                <CheckItemRow
                  key={item.name}
                  item={item}
                  showDivider={i < result.checkItems.length - 1}
                  animate
                />
              ))}
            </div>
          </div>

          {/* AI summary */}
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>
              AI Summary
            </div>
            <div style={{ fontSize: 14, color: "var(--text-primary)", lineHeight: 1.5 }}>
              {result.summary}
            </div>
          </div>

          {/* New inspection button */}
          <button
            onClick={reset}
            style={{
              width: "100%",
              padding: "14px 0",
              borderRadius: 16,
              border: "1px solid var(--border)",
              background: "var(--card)",
              color: "var(--text-secondary)",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            New Inspection
          </button>
        </>
      )}

    </div>
  );
}

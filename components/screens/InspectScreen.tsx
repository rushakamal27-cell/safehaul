"use client";
import { useRef, useState } from "react";
import { useTelegram } from "@/lib/useTelegram";
import type { CheckItem, InspectionResult } from "@/lib/inspection";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compress an image file client-side using Canvas. Returns a JPEG Blob. */
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  PASS: { bg: "var(--green-dim)",              color: "var(--green)",  border: "rgba(0,232,122,0.3)"  },
  WARN: { bg: "rgba(255,214,0,0.12)",          color: "var(--yellow)", border: "rgba(255,214,0,0.3)"  },
  FAIL: { bg: "var(--red-dim)",                color: "var(--red)",    border: "rgba(255,60,60,0.3)"  },
};

const ITEM_ICONS: Record<string, string> = {
  Tires:       "🛞",
  Brakes:      "🔴",
  Lights:      "💡",
  Windshield:  "🪟",
  "Engine Bay":"⚙️",
};

function CheckItemCard({ item, animate }: { item: CheckItem; animate?: boolean }) {
  const s = STATUS_STYLES[item.status] ?? STATUS_STYLES.WARN;
  return (
    <div className="flex items-center gap-3 rounded-xl p-[12px_14px]" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
      <span className="text-[18px] flex-shrink-0">{ITEM_ICONS[item.name] ?? "🔍"}</span>
      <div className="flex-1">
        <div className="text-[14px] font-semibold" style={{ color: "var(--text-primary)" }}>{item.name}</div>
        <div className="font-mono text-[10px] mt-[2px]" style={{ color: "var(--text-secondary)" }}>{item.detail}</div>
      </div>
      <div
        className={`font-mono text-[10px] px-2 py-[3px] rounded-xl font-bold tracking-[1px] ${animate && item.status === "FAIL" ? "status-blink" : ""}`}
        style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
      >
        {item.status}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl p-[12px_14px] animate-pulse" style={{ background: "var(--bg-card)", border: "1px solid var(--border)", height: "64px" }} />
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

type ScreenState = "idle" | "uploading" | "results";

interface InspectionResponse extends InspectionResult {
  id: string;
  signedPhotoUrl: string;
}

export function InspectScreen() {
  const telegramUser = useTelegram();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [state,   setState]   = useState<ScreenState>("idle");
  const [result,  setResult]  = useState<InspectionResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) fileInputRef.current!.value = "";
    if (!file || !telegramUser) return;

    setError(null);
    setState("uploading");

    try {
      // Step 1: resolve driverId
      const driverRes = await fetch("/api/driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramUserId: telegramUser.id, name: telegramUser.firstName }),
      });
      if (!driverRes.ok) throw new Error("Could not resolve driver");
      const { driver } = await driverRes.json();

      // Step 2: compress image client-side
      const compressed = await compressImage(file);

      // Step 3: upload to API
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

    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function reset() {
    setResult(null);
    setError(null);
    setState("idle");
  }

  const overallStyle = result ? (STATUS_STYLES[result.overallResult] ?? STATUS_STYLES.WARN) : null;

  return (
    <div className="animate-fade-in">
      <p className="font-mono text-[10px] tracking-[2px] uppercase mb-[10px]" style={{ color: "var(--text-secondary)" }}>
        Computer Vision · AR Inspection
      </p>

      {/* ── AR Viewport ── */}
      <div className="rounded-2xl overflow-hidden relative h-[280px] mb-4" style={{ background: "#000", border: `1px solid ${overallStyle?.border ?? "var(--border-bright)"}` }}>
        <div className="w-full h-full flex items-center justify-center relative" style={{ background: "linear-gradient(180deg,#0a1a10 0%,#050e08 100%)" }}>
          <span className="text-[90px]" style={{ opacity: 0.18 }}>🚛</span>

          <div className="absolute inset-0">
            <div className="reticle-tl" /><div className="reticle-tr" />
            <div className="reticle-bl" /><div className="reticle-br" />

            {/* Scan line — always visible when uploading, hidden otherwise */}
            {state === "uploading" && <div className="ar-scan-line" />}

            {/* Status chip */}
            <div
              className="absolute top-3 left-1/2 -translate-x-1/2 font-mono text-[9px] px-[10px] py-[3px] rounded-full whitespace-nowrap"
              style={{
                color:      state === "results" ? overallStyle!.color : "var(--green)",
                background: "rgba(0,0,0,0.7)",
                border:     `1px solid ${state === "results" ? overallStyle!.border : "rgba(0,232,122,0.3)"}`,
              }}
            >
              {state === "idle"      && "● READY TO SCAN"}
              {state === "uploading" && "● ANALYZING…"}
              {state === "results"   && `● ${result!.overallResult} — ${Math.round(result!.confidence * 100)}% CONFIDENCE`}
            </div>

            {/* Result bounding-box overlays */}
            {state === "results" && result && (() => {
              const positions = [
                { left:"12%", top:"55%", w:"22%", h:"28%" },
                { left:"65%", top:"52%", w:"24%", h:"30%" },
                { left:"38%", top:"30%", w:"26%", h:"22%" },
                { left:"12%", top:"22%", w:"22%", h:"22%" },
                { left:"65%", top:"22%", w:"24%", h:"22%" },
              ];
              return result.checkItems.map((item, i) => {
                const s  = STATUS_STYLES[item.status] ?? STATUS_STYLES.WARN;
                const p  = positions[i] ?? positions[0];
                return (
                  <div
                    key={item.name}
                    className="bbox-anim absolute"
                    style={{ left:p.left, top:p.top, width:p.w, height:p.h, border:`2px solid ${s.color}`, borderRadius:"4px", boxShadow:`0 0 10px ${s.color}40` }}
                  >
                    <span
                      className="absolute -top-[22px] -left-[1px] font-mono text-[9px] px-[6px] py-[2px] rounded-[3px]"
                      style={{ background:s.color, color: item.status === "WARN" ? "#000" : item.status === "PASS" ? "#000" : "#fff" }}
                    >
                      {item.name.toUpperCase()}
                    </span>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <p className="font-mono text-[11px] text-center mb-3" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}

      {/* ── Action area ── */}
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
            className="w-full py-[14px] rounded-2xl font-display font-black text-[15px] tracking-[3px] uppercase mb-4"
            style={{
              background: state === "uploading"
                ? "rgba(0,200,255,0.05)"
                : "linear-gradient(135deg,rgba(0,200,255,0.12),rgba(0,200,255,0.06))",
              border: "1px solid var(--cyan)",
              color:  state === "uploading" ? "var(--text-secondary)" : "var(--cyan)",
              cursor: state === "uploading" ? "not-allowed" : "pointer",
            }}
          >
            {state === "uploading" ? "ANALYZING VEHICLE…" : "📷 TAP TO INSPECT"}
          </button>
        </>
      )}

      {/* ── Check item list ── */}
      <p className="font-mono text-[10px] tracking-[2px] uppercase mb-[10px]" style={{ color: "var(--text-secondary)" }}>
        Pre-Trip Inspection Checklist
      </p>

      <div className="flex flex-col gap-2">
        {state === "uploading" && [1,2,3,4,5].map((i) => <SkeletonCard key={i} />)}

        {state === "results" && result && (
          <>
            {result.checkItems.map((item) => (
              <CheckItemCard key={item.name} item={item} animate />
            ))}

            {/* Summary + new inspection button */}
            <div className="rounded-xl p-[12px_14px] mt-1" style={{ background: "var(--bg-card)", border: `1px solid ${overallStyle!.border}` }}>
              <p className="font-mono text-[10px] mb-1" style={{ color: "var(--text-secondary)" }}>AI SUMMARY</p>
              <p className="text-[13px] leading-snug" style={{ color: "var(--text-primary)" }}>{result.summary}</p>
            </div>

            <button
              onClick={reset}
              className="w-full py-[12px] rounded-2xl font-display font-bold text-[13px] tracking-[2px] uppercase mt-1"
              style={{ background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer" }}
            >
              NEW INSPECTION
            </button>
          </>
        )}

        {state === "idle" && (
          <div className="rounded-xl p-[14px] text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="font-mono text-[11px]" style={{ color: "var(--text-secondary)" }}>
              Tap the button above to photograph your vehicle.<br />
              The AI will analyze it and generate an inspection report.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

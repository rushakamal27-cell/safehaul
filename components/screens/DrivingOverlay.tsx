"use client";

import { useLanguage } from "@/lib/i18n/LanguageContext";

interface DrivingOverlayProps {
  isVisible: boolean;
  onVoiceActivate: () => void;
  onCopyPhrase: (phrase: string) => void;
}

const phrases = [
  { tag: "MECHANICAL", text: "ADVISE: MECHANICAL FAILURE — SHOULDER POSITIONED — HAZARD ACTIVE" },
  { tag: "WEATHER", text: "REPORT: REDUCED VISIBILITY — FOG — SPEED REDUCED TO 35" },
  { tag: "INSPECTION", text: "COMPLY: WEIGH STATION — PROCEEDING — ETA 2 MINUTES" },
  { tag: "EMERGENCY", text: "MAYDAY: CARGO SHIFT — EMERGENCY BRAKE APPLIED — REQUEST ASSISTANCE" },
];

export function DrivingOverlay({ isVisible, onVoiceActivate, onCopyPhrase }: DrivingOverlayProps) {
  const { t } = useLanguage();
  if (!isVisible) return null;
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center pt-10 pb-[90px] overflow-y-auto animate-slide-up px-4" style={{ background: "var(--bg-deep)" }}>
      <div className="flex flex-col items-center mb-7 mt-10">
        <button onClick={onVoiceActivate} className="relative w-[86px] h-[86px] rounded-full flex flex-col items-center justify-center cursor-pointer transition-all duration-200" style={{ background: "linear-gradient(135deg, #001a26, #002233)", border: "3px solid var(--cyan)", boxShadow: "0 0 30px var(--cyan-glow), 0 0 60px rgba(0,200,255,0.15)" }}>
          <div className="fab-ring absolute rounded-full pointer-events-none" style={{ inset: "-8px", border: "1px solid rgba(0,200,255,0.2)" }} />
          <span className="text-[28px]">🎙️</span>
          <span className="font-mono text-[8px] tracking-[1px] mt-[2px]" style={{ color: "var(--cyan)" }}>{t("voiceLabel")}</span>
        </button>
        <p className="font-mono text-[9px] tracking-[1px] mt-[6px]" style={{ color: "var(--text-secondary)" }}>{t("tapToSpeak")}</p>
      </div>
      {/* The ICAO-style radio phraseology strings below (`phrases`) are
          deliberately left in English — standardized aviation/radio
          protocol phraseology, not driver-facing prose, matching how brand
          names are never translated (see the Plan Mode report's section
          B). Only the surrounding chrome is localized. */}
      <div className="w-full rounded-xl p-4 relative overflow-hidden" style={{ background: "#040a06", border: "1px solid rgba(0,232,122,0.3)" }}>
        <div className="absolute top-[10px] right-[14px] font-mono text-[9px] dot-pulse" style={{ color: "var(--red)" }}>● {t("recIndicator")}</div>
        <div className="font-mono text-[9px] tracking-[2px] uppercase mb-[10px]" style={{ color: "var(--text-secondary)" }}>📡 {t("phraseologyPrompt")}</div>
        <div className="flex flex-col gap-2">
          {phrases.map((phrase) => (
            <button key={phrase.tag} onClick={() => onCopyPhrase(phrase.text)} className="text-left rounded-[6px] p-[8px_12px] font-mono text-[12px] cursor-pointer transition-all duration-200 w-full" style={{ background: "rgba(0,232,122,0.05)", border: "1px solid rgba(0,232,122,0.15)", color: "var(--green)" }}>
              <span className="block font-mono text-[9px] tracking-[2px] mb-[2px]" style={{ color: "var(--text-secondary)" }}>{phrase.tag}</span>
              {phrase.text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

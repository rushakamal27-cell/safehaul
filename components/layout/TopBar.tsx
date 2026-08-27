"use client";

import { useLanguage } from "@/lib/i18n/LanguageContext";

interface TopBarProps {
  isDriving: boolean;
  onToggleDriving: () => void;
}

export function TopBar({ isDriving, onToggleDriving }: TopBarProps) {
  const { t } = useLanguage();
  return (
    <header
      className="flex items-center justify-between px-5 sticky top-0 z-[100]"
      style={{
        height: 56,
        background: "rgba(8, 16, 24, 0.92)",
        borderBottom: "1px solid var(--border)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
      }}
    >
      {/* Wordmark */}
      <span
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          fontWeight: 700,
          fontSize: 17,
          letterSpacing: "-0.4px",
          color: "var(--text-primary)",
        }}
      >
        Safe<span style={{ color: "var(--blue)" }}>Haul</span>
      </span>

      {/* GPS status */}
      <div className="flex items-center gap-2">
        <div
          className="dot-pulse"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--green)",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 500,
            fontSize: 12,
            color: "var(--text-secondary)",
          }}
        >
          {t("gpsActive")}
        </span>
      </div>
    </header>
  );
}

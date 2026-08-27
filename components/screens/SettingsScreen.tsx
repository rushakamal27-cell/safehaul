"use client";

import { useEffect, useState } from "react";
import { useTelegram } from "@/lib/useTelegram";
import { resolveDisplayName } from "@/lib/driverIdentity";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import {
  User, Bell, SlidersHorizontal, Bluetooth, Shield,
  Info, ChevronRight, LogOut, Languages,
} from "lucide-react";

// ── Sub-components ─────────────────────────────────────────────────────────────

interface RowProps {
  icon: React.ReactNode;
  iconColor?: string;
  iconBg?: string;
  label: string;
  value?: string;
  onClick?: () => void;
  destructive?: boolean;
}

function SettingsRow({ icon, iconColor = "var(--blue)", iconBg, label, value, onClick, destructive }: RowProps) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "13px 16px",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {/* Icon chip */}
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          background: iconBg ?? `${iconColor}14`,
          border: `1px solid ${iconColor}28`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: destructive ? "var(--red)" : iconColor,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>

      {/* Label */}
      <span
        style={{
          flex: 1,
          fontSize: 14,
          fontWeight: 500,
          color: destructive ? "var(--red)" : "var(--text-primary)",
        }}
      >
        {label}
      </span>

      {/* Value + chevron */}
      {value && (
        <span style={{ fontSize: 13, color: "var(--text-secondary)", marginRight: 4 }}>
          {value}
        </span>
      )}
      {onClick && !destructive && (
        <ChevronRight size={16} strokeWidth={1.75} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
      )}
    </div>
  );
}

interface SectionProps {
  title?: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      {title && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.6px",
            marginBottom: 8,
            paddingLeft: 4,
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 20,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "var(--border)", marginLeft: 62 }} />;
}

// ── Main component ─────────────────────────────────────────────────────────────

interface SettingsScreenProps {
  onLogout?: () => void;
}

export function SettingsScreen({ onLogout }: SettingsScreenProps) {
  const telegramUser = useTelegram();
  const { language, setLanguage, t } = useLanguage();
  const [canonicalName, setCanonicalName] = useState<string | null>(null);

  // Resolve the driver record once to pick up canonicalName (real operational
  // identity) for display — see lib/driverIdentity.ts. Read-only: this screen
  // doesn't need driverId, so it doesn't send lastName/username on this call.
  useEffect(() => {
    if (!telegramUser) return;
    let cancelled = false;

    fetch("/api/driver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegramUserId: telegramUser.id, name: telegramUser.firstName }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.driver) setCanonicalName(data.driver.canonicalName ?? null);
      })
      .catch(() => {
        // Non-fatal — falls back to Telegram-derived display name below.
      });

    return () => { cancelled = true; };
  }, [telegramUser]);

  const displayName = resolveDisplayName({
    canonicalName,
    telegramFirstName: telegramUser?.firstName,
    telegramLastName:  telegramUser?.lastName,
    telegramUsername:  telegramUser?.username,
  });

  const iconSize = { size: 16, strokeWidth: 1.75 } as const;

  return (
    <div className="animate-fade-in" style={{ padding: "24px 20px 8px", display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Page header + profile card */}
      <div>
        <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.4px", marginBottom: 20 }}>
          {t("settingsTitle")}
        </div>

        {/* Profile card */}
        <div
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 20,
            padding: "20px",
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          {/* Avatar */}
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: "50%",
              background: "var(--blue-dim)",
              border: "1.5px solid var(--blue-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--blue)",
              flexShrink: 0,
              fontSize: 20,
            }}
          >
            {displayName.replace(/^@/, "").charAt(0).toUpperCase()}
          </div>

          {/* Name + role */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
              {displayName}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("professionalDriver")}
            </div>
          </div>

          {/* Status pill */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: "var(--green-dim)",
              border: "1px solid var(--green-border)",
              borderRadius: 99,
              padding: "4px 10px",
            }}
          >
            <div className="dot-pulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--green)" }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--green)" }}>{t("active")}</span>
          </div>
        </div>
      </div>

      {/* ── Account section ────────────────────────────────────────────────────── */}
      <Section title={t("sectionAccount")}>
        <SettingsRow
          icon={<User {...iconSize} />}
          iconColor="var(--blue)"
          label={t("driverProfile")}
          value={t("view")}
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<Bell {...iconSize} />}
          iconColor="var(--warning)"
          label={t("notifications")}
          value={t("on")}
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<SlidersHorizontal {...iconSize} />}
          iconColor="var(--green)"
          label={t("preferences")}
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<Languages {...iconSize} />}
          iconColor="var(--blue)"
          label={t("language")}
          value={language === "en" ? "English" : "Русский"}
          onClick={() => setLanguage(language === "en" ? "ru" : "en")}
        />
      </Section>

      {/* ── System section ─────────────────────────────────────────────────────── */}
      <Section title={t("sectionSystem")}>
        <SettingsRow
          icon={<Bluetooth {...iconSize} />}
          iconColor="var(--blue)"
          label={t("connectedDevices")}
          value="Samsara"
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<Shield {...iconSize} />}
          iconColor="var(--green)"
          label={t("privacy")}
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<Info {...iconSize} />}
          iconColor="var(--text-tertiary)"
          iconBg="rgba(77,100,120,0.12)"
          label={t("aboutSafeHaul")}
          value="v0.2"
          onClick={() => {}}
        />
      </Section>

      {/* ── Log out ────────────────────────────────────────────────────────────── */}
      <Section>
        <SettingsRow
          icon={<LogOut {...iconSize} />}
          iconColor="var(--red)"
          label={t("logOut")}
          destructive
          onClick={onLogout}
        />
      </Section>

      {/* Footer */}
      <div style={{ textAlign: "center", paddingTop: 4, paddingBottom: 8 }}>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{t("footerVersion")}</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 3 }}>{t("footerBuiltFor")}</div>
      </div>

    </div>
  );
}

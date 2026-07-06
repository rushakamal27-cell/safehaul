"use client";

import { useTelegram } from "@/lib/useTelegram";
import {
  User, Bell, SlidersHorizontal, Bluetooth, Shield,
  Info, ChevronRight, LogOut,
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

  const iconSize = { size: 16, strokeWidth: 1.75 } as const;

  return (
    <div className="animate-fade-in" style={{ padding: "24px 20px 8px", display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Page header + profile card */}
      <div>
        <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.4px", marginBottom: 20 }}>
          Settings
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
            {telegramUser?.firstName?.charAt(0)?.toUpperCase() ?? "D"}
          </div>

          {/* Name + role */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
              {telegramUser?.firstName ? telegramUser.firstName : "Driver"}
              {telegramUser?.username ? ` @${telegramUser.username}` : ""}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Professional Driver · SafeHaul
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
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--green)" }}>Active</span>
          </div>
        </div>
      </div>

      {/* ── Account section ────────────────────────────────────────────────────── */}
      <Section title="Account">
        <SettingsRow
          icon={<User {...iconSize} />}
          iconColor="var(--blue)"
          label="Driver Profile"
          value="View"
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<Bell {...iconSize} />}
          iconColor="var(--warning)"
          label="Notifications"
          value="On"
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<SlidersHorizontal {...iconSize} />}
          iconColor="var(--green)"
          label="Preferences"
          onClick={() => {}}
        />
      </Section>

      {/* ── System section ─────────────────────────────────────────────────────── */}
      <Section title="System">
        <SettingsRow
          icon={<Bluetooth {...iconSize} />}
          iconColor="var(--blue)"
          label="Connected Devices"
          value="Samsara"
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<Shield {...iconSize} />}
          iconColor="var(--green)"
          label="Privacy"
          onClick={() => {}}
        />
        <Divider />
        <SettingsRow
          icon={<Info {...iconSize} />}
          iconColor="var(--text-tertiary)"
          iconBg="rgba(77,100,120,0.12)"
          label="About SafeHaul"
          value="v0.2"
          onClick={() => {}}
        />
      </Section>

      {/* ── Log out ────────────────────────────────────────────────────────────── */}
      <Section>
        <SettingsRow
          icon={<LogOut {...iconSize} />}
          iconColor="var(--red)"
          label="Log Out"
          destructive
          onClick={onLogout}
        />
      </Section>

      {/* Footer */}
      <div style={{ textAlign: "center", paddingTop: 4, paddingBottom: 8 }}>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>SafeHaul v0.2.0 · Operational Safety Platform</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 3 }}>Built for professional drivers</div>
      </div>

    </div>
  );
}

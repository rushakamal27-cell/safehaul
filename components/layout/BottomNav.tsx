"use client";

import { useLanguage } from "@/lib/i18n/LanguageContext";

type Tab = "dash" | "inspect" | "audit" | "settings";

interface BottomNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

// Lucide-style inline SVGs — consistent 1.75px stroke, rounded caps
function HeadsUpIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 6v6l3 3" />
      <path d="M22 2 12 12" />
    </svg>
  );
}

function InspectIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function AuditIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const TAB_KEYS: { id: Tab; key: "navHeadsUp" | "navInspect" | "navAudit" | "navSettings"; Icon: () => JSX.Element }[] = [
  { id: "dash",     key: "navHeadsUp",  Icon: HeadsUpIcon  },
  { id: "inspect",  key: "navInspect",  Icon: InspectIcon  },
  { id: "audit",    key: "navAudit",    Icon: AuditIcon    },
  { id: "settings", key: "navSettings", Icon: SettingsIcon },
];

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  const { t } = useLanguage();
  return (
    <nav
      className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[420px] flex justify-around z-[200]"
      style={{
        background: "rgba(8, 16, 24, 0.96)",
        borderTop: "1px solid var(--border)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        paddingTop: 8,
        paddingBottom: "calc(10px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      {TAB_KEYS.map(({ id, key, Icon }) => {
        const active = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className="flex flex-col items-center gap-[3px] bg-transparent border-none cursor-pointer transition-colors duration-150"
            style={{
              color: active ? "var(--blue)" : "var(--text-tertiary)",
              minWidth: 60,
              padding: "4px 8px",
            }}
          >
            <Icon />
            <span
              style={{
                fontSize: 10,
                fontWeight: active ? 600 : 400,
                letterSpacing: "0.1px",
                whiteSpace: "nowrap",
              }}
            >
              {t(key)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

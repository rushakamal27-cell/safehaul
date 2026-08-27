"use client";

import { useState, useCallback, useEffect } from "react";
import { TopBar } from "@/components/layout/TopBar";
import { BottomNav } from "@/components/layout/BottomNav";
import { Toast } from "@/components/ui/Toast";
import { DashboardScreen } from "@/components/screens/DashboardScreen";
import { InspectScreen } from "@/components/screens/InspectScreen";
import { AuditScreen } from "@/components/screens/AuditScreen";
import { DrivingOverlay } from "@/components/screens/DrivingOverlay";
import { SettingsScreen } from "@/components/screens/SettingsScreen";
import { LegalGateScreen } from "@/components/screens/LegalGateScreen";
import { useTelegram } from "@/lib/useTelegram";
import type { LegalDocumentSummary } from "@/lib/legal";
import { useLanguage } from "@/lib/i18n/LanguageContext";

type Tab = "dash" | "inspect" | "audit" | "settings";

export default function Home() {
  const { t } = useLanguage();
  const [activeTab, setActiveTab]   = useState<Tab>("dash");
  const [isDriving, setIsDriving]   = useState(false);
  const [toast, setToast]           = useState({ msg: "", visible: false });

  const telegramUser = useTelegram();
  const [driverId,   setDriverId]   = useState<string | null>(null);
  const [legalGate,  setLegalGate]  = useState<"checking" | "required" | "clear">("checking");
  const [pendingDocs, setPendingDocs] = useState<LegalDocumentSummary[]>([]);

  // ── Resolve driver + legal-acceptance gate (Phase 4.6B) ──────────────────
  // Runs once telegramUser is available; each screen still resolves its own
  // driverId independently as before — this is only for the gate itself.
  const checkLegalStatus = useCallback(async (id: string) => {
    const statusRes = await fetch(`/api/legal/status?driverId=${id}`);
    if (!statusRes.ok) throw new Error(`Legal status API failed: ${statusRes.status}`);
    const status = await statusRes.json();
    if (status.onboardingComplete) {
      setLegalGate("clear");
      setPendingDocs([]);
    } else {
      setPendingDocs(status.pending);
      setLegalGate("required");
    }
  }, []);

  useEffect(() => {
    if (!telegramUser) return;
    let cancelled = false;

    async function resolveAndCheck() {
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
        if (cancelled) return;
        setDriverId(driver.id);
        await checkLegalStatus(driver.id);
      } catch (err) {
        console.error("[page] Failed to resolve driver/legal status:", err);
        // Fail open rather than permanently locking a driver out on a transient
        // network error — the gate simply re-checks on next load.
        if (!cancelled) setLegalGate("clear");
      }
    }

    resolveAndCheck();
    return () => { cancelled = true; };
  }, [telegramUser, checkLegalStatus]);

  const showToast = useCallback((msg: string) => {
    setToast({ msg, visible: true });
    setTimeout(() => setToast((t) => ({ ...t, visible: false })), 2800);
  }, []);

  const handleTabChange = (tab: Tab) => setActiveTab(tab);

  const handleToggleDriving = () => {
    const next = !isDriving;
    setIsDriving(next);
    showToast(next ? t("toastDrivingOn") : t("toastDrivingOff"));
  };

  // ── Legal gate takes over the whole screen until accepted ────────────────
  // Blocks on "checking" too — the dashboard must never flash before we know
  // whether this driver still needs to accept something.
  if (legalGate === "checking" || legalGate === "required") {
    return (
      <div
        className="max-w-[420px] min-h-screen mx-auto relative overflow-hidden"
        style={{ background: "var(--bg)" }}
      >
        {legalGate === "required" && driverId && (
          <LegalGateScreen
            driverId={driverId}
            pending={pendingDocs}
            onAccepted={() => setLegalGate("clear")}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col max-w-[420px] min-h-screen mx-auto relative overflow-hidden"
      style={{ background: "var(--bg)" }}
    >
      <TopBar isDriving={isDriving} onToggleDriving={handleToggleDriving} />

      <DrivingOverlay
        isVisible={isDriving}
        onVoiceActivate={() => showToast(t("toastListening"))}
        onCopyPhrase={(p) => { navigator.clipboard?.writeText(p); showToast(t("toastPhraseCopied")); }}
      />

      {!isDriving && (
        <main
          className="flex-1 overflow-y-auto"
          style={{ paddingBottom: "calc(72px + env(safe-area-inset-bottom, 0px))" }}
        >
          {activeTab === "dash"     && (
            <DashboardScreen
              onIncident={() => showToast(t("toastIncidentSubmitted"))}
            />
          )}
          {activeTab === "inspect"  && <InspectScreen />}
          {activeTab === "audit"    && (
            <AuditScreen
              onGenerateReport={() => showToast(t("toastGeneratingReport"))}
              onExpandCard={() => showToast(t("toastLoadingEventDetails"))}
            />
          )}
          {activeTab === "settings" && (
            <SettingsScreen
              onLogout={() => showToast(t("toastLoggedOut"))}
            />
          )}
        </main>
      )}

      <BottomNav activeTab={activeTab} onTabChange={handleTabChange} />
      <Toast message={toast.msg} visible={toast.visible} />
    </div>
  );
}

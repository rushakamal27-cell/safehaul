"use client";

import { useState, useCallback } from "react";
import { TopBar } from "@/components/layout/TopBar";
import { BottomNav } from "@/components/layout/BottomNav";
import { Toast } from "@/components/ui/Toast";
import { DashboardScreen } from "@/components/screens/DashboardScreen";
import { InspectScreen } from "@/components/screens/InspectScreen";
import { AuditScreen } from "@/components/screens/AuditScreen";
import { DrivingOverlay } from "@/components/screens/DrivingOverlay";

type Tab = "dash" | "inspect" | "audit";

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("dash");
  const [isDriving, setIsDriving] = useState(false);
  const [toast, setToast] = useState({ msg: "", visible: false });

  const showToast = useCallback((msg: string) => {
    setToast({ msg, visible: true });
    setTimeout(() => setToast((t) => ({ ...t, visible: false })), 2800);
  }, []);

  const handleTabChange = (tab: Tab) => setActiveTab(tab);

  const handleToggleDriving = () => {
    const next = !isDriving;
    setIsDriving(next);
    showToast(next ? "🚛 Driving Mode ON — Voice-First Active" : "🅿 Parked — Dashboard Restored");
  };

  return (
    <div className="flex flex-col max-w-[420px] min-h-screen mx-auto relative overflow-hidden" style={{ background: "var(--bg-deep)", boxShadow: "0 0 80px rgba(0,200,255,0.06)" }}>
      <TopBar isDriving={isDriving} onToggleDriving={handleToggleDriving} />
      <DrivingOverlay isVisible={isDriving} onVoiceActivate={() => showToast("🎙️ Listening... Speak phraseology")} onCopyPhrase={(p) => { navigator.clipboard?.writeText(p); showToast("📋 Phrase copied"); }} />
      {!isDriving && (
        <main className="flex-1 px-4 overflow-y-auto" style={{ paddingBottom: "calc(90px + env(safe-area-inset-bottom, 0px))", paddingTop: "16px" }}>
          {activeTab === "dash" && <DashboardScreen onIncident={() => showToast("⚡ Incident report submitted — visible in Audit trail")} />}
          {activeTab === "inspect" && <InspectScreen />}
          {activeTab === "audit" && <AuditScreen onGenerateReport={() => showToast("📄 Generating FMCSA-Ready PDF Report...")} onExpandCard={() => showToast("📄 Loading full event details...")} />}
        </main>
      )}
      <BottomNav activeTab={activeTab} onTabChange={handleTabChange} />
      <Toast message={toast.msg} visible={toast.visible} />
    </div>
  );
}

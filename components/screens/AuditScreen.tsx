"use client";
import { useEffect, useState } from "react";
import { useTelegram } from "@/lib/useTelegram";
import { AuditEvent } from "@/lib/audit";
import type { DriverLocation } from "@/lib/location";

function EventCard({ date, badge, badgeType, title, detail, meta, onClick }: { date:string; badge:string; badgeType:"pass"|"fail"|"warn"|"info"; title:string; detail:string; meta:string[]; onClick:()=>void }) {
  const lines = { pass:"var(--green)", fail:"var(--red)", warn:"var(--orange)", info:"var(--cyan)" };
  const badges = { pass:{bg:"var(--green-dim)",color:"var(--green)"}, fail:{bg:"var(--red-dim)",color:"var(--red)"}, warn:{bg:"var(--orange-dim)",color:"var(--orange)"}, info:{bg:"var(--cyan-dim)",color:"var(--cyan)"} };
  return (
    <div className="rounded-2xl p-[14px_16px] mb-[10px] relative overflow-hidden cursor-pointer transition-all duration-200" style={{background:"var(--bg-card)",border:"1px solid var(--border)"}} onClick={onClick}>
      <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{background:lines[badgeType]}} />
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[10px]" style={{color:"var(--text-secondary)"}}>{date}</span>
        <span className="font-mono text-[9px] px-2 py-[2px] rounded-[10px] tracking-[1px] font-bold" style={{background:badges[badgeType].bg,color:badges[badgeType].color}}>{badge}</span>
      </div>
      <div className="font-display font-bold text-[15px] mb-[6px]" style={{color:"var(--text-primary)"}}>{title}</div>
      <div className="font-mono text-[10px] leading-relaxed" style={{color:"var(--text-secondary)"}}>{detail}</div>
      <div className="flex gap-3 mt-2 flex-wrap">{meta.map(m=><span key={m} className="font-mono text-[9px]" style={{color:"var(--text-secondary)"}}>{m}</span>)}</div>
    </div>
  );
}

export function AuditScreen({ onGenerateReport, onExpandCard }: { onGenerateReport:()=>void; onExpandCard:()=>void }) {
  const telegramUser = useTelegram();

  const [events, setEvents]       = useState<AuditEvent[]>([]);
  const [location, setLocation]   = useState<DriverLocation | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [showAll, setShowAll]     = useState(false);

  const PAGE = 10;
  const visibleEvents = showAll ? events : events.slice(0, PAGE);
  const hasMore       = events.length > PAGE;

  useEffect(() => {
    if (!telegramUser) return;

    let cancelled = false;

    async function loadAudit() {
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

        // Step 2: fetch audit events and location in parallel
        const [auditRes, locationRes] = await Promise.all([
          fetch(`/api/audit?driverId=${driver.id}`),
          fetch(`/api/location?driverId=${driver.id}`),
        ]);

        if (!auditRes.ok) throw new Error(`Audit API failed: ${auditRes.status}`);
        const data = await auditRes.json();

        if (!cancelled) {
          setEvents(data.events);
          if (locationRes.ok) setLocation(await locationRes.json());
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message ?? "Failed to load audit data");
          setLoading(false);
        }
      }
    }

    loadAudit();
    return () => { cancelled = true; };
  }, [telegramUser]);

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-[14px]">
        <h2 className="font-display font-bold text-[18px]">Audit Trail</h2>
        <button onClick={onGenerateReport} className="font-ui font-bold text-[11px] px-3 py-[7px] rounded-lg tracking-[1px] cursor-pointer" style={{background:"linear-gradient(135deg,rgba(0,200,255,0.1),rgba(0,200,255,0.05))",border:"1px solid var(--cyan)",color:"var(--cyan)"}}>⬇ FMCSA REPORT</button>
      </div>

      {/* ── Map (static, unchanged) ── */}
      <div className="rounded-xl p-[14px] mb-4 relative overflow-hidden" style={{background:"#050e0a",border:"1px solid rgba(0,200,255,0.2)"}}>
        <div className="font-mono text-[9px] tracking-[2px] mb-[2px]" style={{color:"var(--cyan)"}}>
          📍 {location ? location.locationLabel.toUpperCase() : "INCIDENT LOCATION MAP · SYNCED"}
        </div>
        {location?.zoneName && (
          <div className="font-mono text-[9px] mb-[10px]" style={{color:"var(--text-secondary)"}}>
            {location.zoneName}
          </div>
        )}
        <div className="w-full h-[120px] relative rounded-[6px]" style={{backgroundImage:"linear-gradient(rgba(0,200,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,200,255,0.04) 1px,transparent 1px)",backgroundSize:"20px 20px"}}>
          <svg style={{position:"absolute",inset:0,width:"100%",height:"100%"}} viewBox="0 0 340 120">
            <polyline points="30,90 80,70 130,60 170,65 210,45 260,50 310,35" fill="none" stroke="rgba(0,200,255,0.3)" strokeWidth="2" strokeDasharray="5,3"/>
          </svg>
          {[{left:"24%",top:"58%",type:"check",label:"Pre-Trip"},{left:"50%",top:"54%",type:"incident",label:"Incident"},{left:"77%",top:"37%",type:"check",label:"Inspection"},{left:"91%",top:"29%",type:"current",label:"NOW"}].map(dot=>(
            <div key={dot.label}>
              <div className={`absolute w-2 h-2 rounded-full -translate-x-1/2 -translate-y-1/2 ${dot.type==="incident"?"dot-pulse":dot.type==="current"?"dot-pulse-slow":""}`} style={{left:dot.left,top:dot.top,background:dot.type==="incident"?"var(--red)":dot.type==="current"?"var(--cyan)":"var(--green)",boxShadow:dot.type==="incident"?"0 0 10px var(--red)":dot.type==="current"?"0 0 12px var(--cyan)":"0 0 8px var(--green)"}} />
              <span className="absolute font-mono text-[8px] whitespace-nowrap" style={{left:dot.left,top:dot.top,transform:"translate(8px,-50%)",color:"var(--text-secondary)"}}>{dot.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Event Log ── */}
      <p className="font-mono text-[10px] tracking-[2px] uppercase mb-[10px]" style={{color:"var(--text-secondary)"}}>Event Log</p>

      {loading && (
        <div className="flex flex-col gap-[10px]">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl p-[14px_16px] animate-pulse" style={{background:"var(--bg-card)",border:"1px solid var(--border)",height:"88px"}} />
          ))}
        </div>
      )}

      {error && (
        <p className="font-mono text-[11px] text-center py-4" style={{color:"var(--red)"}}>
          Failed to load audit events
        </p>
      )}

      {!loading && !error && events.length === 0 && (
        <p className="font-mono text-[11px] text-center py-8" style={{color:"var(--text-secondary)"}}>
          No events recorded yet.{"\n"}Open the Dashboard to begin tracking.
        </p>
      )}

      {!loading && !error && visibleEvents.map((evt) => (
        <EventCard
          key={evt.id}
          date={evt.date}
          badge={evt.badge}
          badgeType={evt.badgeType}
          title={evt.title}
          detail={evt.detail}
          meta={evt.meta}
          onClick={onExpandCard}
        />
      ))}

      {!loading && !error && hasMore && (
        <button
          onClick={() => setShowAll((prev) => !prev)}
          className="w-full py-[10px] font-mono text-[11px] tracking-[1px] rounded-xl mt-1 mb-2"
          style={{ background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--cyan)" }}
        >
          {showAll ? "Show fewer" : `View full audit trail (${events.length - PAGE} more)`}
        </button>
      )}
    </div>
  );
}

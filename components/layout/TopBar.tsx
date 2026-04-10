"use client";

interface TopBarProps {
  isDriving: boolean;
  onToggleDriving: () => void;
}

export function TopBar({ isDriving, onToggleDriving }: TopBarProps) {
  return (
    <header className="flex items-center justify-between px-[18px] py-[14px] border-b sticky top-0 z-[100] backdrop-blur-md" style={{ borderColor: "var(--border)", background: "rgba(8,12,16,0.95)" }}>
      <div className="font-display font-black text-xl tracking-[2px]" style={{ color: "var(--cyan)", textShadow: "0 0 18px var(--cyan-glow)" }}>
        SAFE<span style={{ color: "var(--text-primary)" }}>HAUL</span>
      </div>
      <div className="flex gap-[6px] items-center">
        <div className="font-mono text-[10px] px-2 py-[3px] rounded-full" style={{ background: "var(--green-dim)", color: "var(--green)", border: "1px solid rgba(0,232,122,0.3)" }}>● GPS</div>
        <div className="font-mono text-[10px] px-2 py-[3px] rounded-full" style={{ background: "var(--cyan-dim)", color: "var(--cyan)", border: "1px solid rgba(0,200,255,0.3)" }}>V2X</div>
      </div>
    </header>
  );
}


"use client";

interface ToastProps {
  message: string;
  visible: boolean;
}

export function Toast({ message, visible }: ToastProps) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 88,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 18px",
        borderRadius: 99,
        background: "var(--card)",
        border: "1px solid var(--border-strong)",
        color: "var(--text-primary)",
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: "nowrap",
        pointerEvents: "none",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
    >
      {message}
    </div>
  );
}

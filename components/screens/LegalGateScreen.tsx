"use client";

import { useEffect, useState } from "react";
import type { LegalDocumentSummary } from "@/lib/legal";

// ── Types ───────────────────────────────────────────────────────────────────

interface LegalDocumentFull {
  id: string;
  type: string;
  title: string;
  content: string;
}

interface LegalGateScreenProps {
  driverId: string;
  pending: LegalDocumentSummary[];
  onAccepted: () => void;
}

// ── Main component ─────────────────────────────────────────────────────────
// Minimal, professional, no animations (Phase 4.6B, Part F/H). Reuses the
// same design tokens and card/button styling as the rest of SafeHaul —
// intentionally not a new visual language.

export function LegalGateScreen({ driverId, pending, onAccepted }: LegalGateScreenProps) {
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const [documents, setDocuments]       = useState<Record<string, LegalDocumentFull>>({});
  const [docLoading, setDocLoading]     = useState<string | null>(null);
  const [checked, setChecked]           = useState(false);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);

  async function toggleDocument(type: string) {
    if (expandedType === type) {
      setExpandedType(null);
      return;
    }
    setExpandedType(type);
    if (documents[type]) return;

    setDocLoading(type);
    try {
      const res = await fetch(`/api/legal/document/${encodeURIComponent(type)}`);
      if (!res.ok) throw new Error(`Failed to load document: ${res.status}`);
      const { document } = await res.json();
      setDocuments((prev) => ({ ...prev, [type]: document }));
    } catch {
      setError("Couldn't load that document. Please try again.");
    } finally {
      setDocLoading(null);
    }
  }

  async function handleAgree() {
    if (!checked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const results = await Promise.all(
        pending.map((doc) =>
          fetch("/api/legal/accept", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ driverId, documentId: doc.id }),
          })
        )
      );
      if (results.some((res) => !res.ok)) {
        throw new Error("One or more documents failed to record acceptance");
      }
      onAccepted();
    } catch {
      setError("Something went wrong recording your acceptance. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="flex flex-col"
      style={{ minHeight: "100vh", padding: "48px 20px 32px", gap: 28 }}
    >
      {/* Wordmark */}
      <div style={{ textAlign: "center" }}>
        <span
          style={{
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 700,
            fontSize: 22,
            letterSpacing: "-0.4px",
            color: "var(--text-primary)",
          }}
        >
          Safe<span style={{ color: "var(--blue)" }}>Haul</span>
        </span>
      </div>

      {/* Explanation */}
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
          Before you continue
        </div>
        <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          SafeHaul uses your driving and vehicle data to provide safety recommendations,
          risk scores, and inspection results. Please review and accept the documents
          below to continue.
        </div>
      </div>

      {/* Document links */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {pending.map((doc) => (
          <div
            key={doc.id}
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => toggleDocument(doc.type)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 16px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--blue)",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              View {doc.title}
              <span style={{ color: "var(--text-tertiary)" }}>
                {expandedType === doc.type ? "−" : "›"}
              </span>
            </button>

            {expandedType === doc.type && (
              <div
                style={{
                  padding: "0 16px 16px",
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  maxHeight: 220,
                  overflowY: "auto",
                  borderTop: "1px solid var(--border)",
                  paddingTop: 14,
                }}
              >
                {docLoading === doc.type
                  ? "Loading..."
                  : documents[doc.type]?.content ?? "Unable to load document."}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Checkbox */}
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          fontSize: 13,
          color: "var(--text-secondary)",
          lineHeight: 1.5,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0 }}
        />
        <span>
          I have read and agree to the Terms of Use and acknowledge the Privacy Notice.
        </span>
      </label>

      {error && (
        <div style={{ fontSize: 13, color: "var(--red)" }}>{error}</div>
      )}

      {/* Agree & Continue */}
      <button
        onClick={handleAgree}
        disabled={!checked || submitting}
        style={{
          width: "100%",
          padding: "16px 24px",
          borderRadius: 16,
          border: !checked || submitting ? "1px solid var(--border)" : "1px solid var(--blue-border)",
          background: !checked || submitting ? "var(--card)" : "var(--blue-dim)",
          color: !checked || submitting ? "var(--text-tertiary)" : "var(--blue)",
          fontSize: 15,
          fontWeight: 600,
          cursor: !checked || submitting ? "not-allowed" : "pointer",
        }}
      >
        {submitting ? "Submitting..." : "Agree & Continue"}
      </button>
    </div>
  );
}

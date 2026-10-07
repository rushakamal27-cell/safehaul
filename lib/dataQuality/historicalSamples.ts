/**
 * lib/dataQuality/historicalSamples.ts
 *
 * Classifies an ALREADY-STORED SafetyScoreSample from the provenance inside
 * its breakdownJson, so a Phase 7 dataset loader can identify historically
 * unusable rows without rewriting them.
 *
 * The problem this solves (Phase 6D closure, 2026-10-07): rows written before
 * this phase predate both the `insufficient_context` status and the
 * `dataCompleteness` field. Their stored `contextStatus` column therefore says
 * `partial_live` even for hours that had no live positional input at all — a
 * driver whose Samsara vehicle never resolved accumulated 1,006 samples, every
 * one scored exactly 100.00, all stamped `partial_live`.
 *
 *   => A Phase 7 loader must NOT trust the stored contextStatus column for
 *      historical rows. It must recompute from breakdownJson.contextSources,
 *      which IS present and complete on every existing row (verified: 6,197 of
 *      6,197 parse successfully).
 *
 * Recomputation is safe because `contextSources` is the full per-field
 * provenance (origin/state/provider/observedAt) that the live classifier reads
 * anyway — the value itself is irrelevant to liveness. This module reuses
 * deriveContextStatusFromSources / deriveDataCompletenessFromSources verbatim,
 * so a historical row and a live context can never be judged by different
 * rules.
 *
 * Nothing here writes, deletes, or recomputes any stored row.
 */

import {
  deriveContextStatusFromSources,
  deriveDataCompletenessFromSources,
} from "@/lib/driverContext/contextStatus";
import type { ContextSourceMeta, ContextSources, ContextStatus } from "@/lib/driverContext/types";

export interface HistoricalSampleQuality {
  /** Status recomputed from stored provenance — authoritative for old rows. */
  contextStatus: ContextStatus;
  /** Live-field count out of 6. HOS is dead fleet-wide, so 5/6 is today's ceiling. */
  dataCompleteness: { count: number; total: number };
  /**
   * False when the hour had no live positional evidence, i.e. its score came
   * from toRiskInput's neutral `?? 0` defaults rather than any measurement.
   */
  usable: boolean;
}

/** Returned when breakdownJson carries no readable contextSources. */
export interface UnclassifiableSample {
  contextStatus: null;
  dataCompleteness: null;
  /** Conservative: an unclassifiable row is not treated as clean data. */
  usable: false;
  reason: "no_context_sources";
}

const FIELD_KEYS = [
  "safetyEvents",
  "hos",
  "speed",
  "weather",
  "zoneRisk",
  "location",
] as const;

function isMeta(value: unknown): value is ContextSourceMeta {
  if (typeof value !== "object" || value === null) return false;
  // origin/state are the only properties liveness depends on; both may be
  // null/absent in principle, so presence of the keys is what we require.
  return "origin" in value && "state" in value;
}

/**
 * Extracts ContextSources from a stored breakdownJson blob, or null when the
 * blob is missing//malformed. Defensive because breakdownJson is a Json column
 * with no shape guarantee at the DB level.
 */
export function extractContextSources(breakdownJson: unknown): ContextSources | null {
  if (typeof breakdownJson !== "object" || breakdownJson === null || Array.isArray(breakdownJson)) {
    return null;
  }
  const sources = (breakdownJson as Record<string, unknown>).contextSources;
  if (typeof sources !== "object" || sources === null || Array.isArray(sources)) return null;

  const record = sources as Record<string, unknown>;
  for (const key of FIELD_KEYS) {
    if (!isMeta(record[key])) return null;
  }
  return record as unknown as ContextSources;
}

/**
 * Classifies one stored sample. Pure and deterministic: no DB, no clock, no
 * provider calls, no driver identity involved — a sample is judged solely on
 * the provenance it recorded at the time.
 *
 * Deliberately ignores the row's stored `contextStatus` column, which is
 * unreliable for pre-Phase-6D rows (see the file header).
 */
export function classifyHistoricalSampleQuality(
  breakdownJson: unknown
): HistoricalSampleQuality | UnclassifiableSample {
  const sources = extractContextSources(breakdownJson);
  if (!sources) {
    return {
      contextStatus: null,
      dataCompleteness: null,
      usable: false,
      reason: "no_context_sources",
    };
  }

  const contextStatus = deriveContextStatusFromSources(sources);
  const dataCompleteness = deriveDataCompletenessFromSources(sources);

  return {
    contextStatus,
    dataCompleteness,
    // demo data is not pilot training data either, but that is a cohort
    // question the loader already handles via isPilot; here we only judge
    // whether the hour had measurable conditions behind it.
    usable: contextStatus !== "insufficient_context",
  };
}

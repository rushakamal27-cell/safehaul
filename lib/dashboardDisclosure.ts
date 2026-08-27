/**
 * lib/dashboardDisclosure.ts
 *
 * Pure, unit-tested helpers for the Heads-Up Dashboard's field-status
 * disclosure text (Risk Card footer). Extracted from
 * components/screens/DashboardScreen.tsx so this logic can be tested under
 * the project's standard lib/**\/__tests__ convention — UI component files
 * (.tsx) have no test harness in this repo. No behavior change from the
 * original inline versions except safetyEventsStatusPhrase (new, N2 —
 * Phase 5, 2026-08-05).
 *
 * Localization (2026-08-27): every exported phrase-builder now takes an
 * optional `language` parameter, defaulting to `"en"` — additive and
 * backward-compatible, every existing call site/test keeps passing
 * unmodified. Only the surrounding sentence wording is translated;
 * PROVIDER_LABELS (brand names like "Samsara") are deliberately never
 * translated, matching the rest of SafeHaul's localization plan (provider/
 * product names stay as-is). See lib/i18n/ for the shared Language type
 * and the rest of the presentation-layer translation modules this mirrors.
 */

import type { ContextSourceMeta, ContextSources, ZoneDetail } from "./driverContext/types";
import type { Language } from "./i18n/translations";
import { translateZoneAvailability } from "./i18n/enumLabels";

export type FieldMeta = ContextSourceMeta;
export type SpecialFieldStatus = "live" | "cached" | "unavailable" | "fallback";

// Covers both liveData.provider (a raw provider id string, e.g. "samsara")
// and ContextSources' per-field provider (which also includes the
// non-telematics providers below) — one shared label map for both uses.
// Provider/brand names are never translated (see file header).
export const PROVIDER_LABELS: Record<string, string> = {
  samsara:            "Samsara",
  motive:             "Motive",
  geotab:             "Geotab",
  openweather:        "OpenWeatherMap",
  internal_geofence:  "SafeHaul Zones",
  internal:           "Demo",
};

/**
 * Classifies a field for wording purposes. "cached" is real data that isn't
 * confirmed-fresh this call — it must never read as "live" to a driver.
 * "fallback" covers both a genuine substitution (a real API call failed) and
 * a field with no real source integrated yet — those two cases share a
 * state in the data model and both render as "Demo Data" below, since
 * either way the number on screen did not come from a live provider call.
 */
export function classifySpecial(meta: FieldMeta): SpecialFieldStatus {
  if (meta.state === "unavailable") return "unavailable";
  if (meta.origin === "observed" || meta.origin === "estimated") {
    return meta.state === "fresh" ? "live" : "cached";
  }
  return "fallback";
}

export function providerLabel(provider: FieldMeta["provider"]): string | null {
  if (!provider) return null;
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Whole minutes between an ISO timestamp and now; null if unparseable/absent/in the future (never shown as "-1 min old"). */
export function minutesAgo(observedAt: string | null, now: Date): number | null {
  if (!observedAt) return null;
  const ms = now.getTime() - new Date(observedAt).getTime();
  if (!isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60_000);
}

const FIELD_LABEL_TRANSLATIONS: Record<string, string> = {
  "HOS":            "Часы работы (HOS)",
  "Speed":          "Скорость",
  "Weather":        "Погода",
  "Zone risk":      "Риск участка",
  "Safety events":  "События безопасности",
};

function translateFieldLabel(label: string, language: Language): string {
  if (language === "en") return label;
  return FIELD_LABEL_TRANSLATIONS[label] ?? label;
}

/**
 * One consistent phrase per field, covering all four states the same way
 * for every field — no field gets bespoke wording or generic-only grouping
 * (Phase 5: previously safetyEvents/weather/hos had individually tailored
 * sentences while speed/zoneRisk were only ever grouped generically, which
 * meant the two groups could describe an identically-shaped real/live
 * reading in different words). "Live"/"Cached" name the provider; "Cached"
 * additionally reports how old the reading is when that's computable.
 *
 * NOT used for safetyEvents — see safetyEventsStatusPhrase below, which
 * reports provider sync recency instead of reading age for that field
 * specifically (N2, Phase 5, 2026-08-05).
 */
export function fieldStatusPhrase(label: string, meta: FieldMeta, now: Date, language: Language = "en"): string {
  const displayLabel = translateFieldLabel(label, language);
  const provider = providerLabel(meta.provider);
  const ru = language === "ru";
  switch (classifySpecial(meta)) {
    case "live":
      if (ru) return provider ? `${displayLabel}: в реальном времени (${provider}).` : `${displayLabel}: в реальном времени.`;
      return provider ? `${label}: Live (${provider}).` : `${label}: Live.`;
    case "cached": {
      const mins = minutesAgo(meta.observedAt, now);
      if (ru) {
        const age = mins !== null ? `, ${mins} мин назад` : "";
        return provider
          ? `${displayLabel}: кэш (${provider}${age}).`
          : `${displayLabel}: кэш${age ? ` (${mins} мин назад)` : ""}.`;
      }
      const age = mins !== null ? `, ${mins} min old` : "";
      return provider ? `${label}: Cached (${provider}${age}).` : `${label}: Cached${age ? ` (${mins} min old)` : ""}.`;
    }
    case "unavailable":
      return ru ? `${displayLabel}: недоступно.` : `${label}: Unavailable.`;
    case "fallback":
      return ru ? `${displayLabel}: демо-данные.` : `${label}: Demo Data.`;
  }
}

/**
 * Zone risk gets its own phrase instead of going through fieldStatusPhrase's
 * generic live/cached/unavailable/fallback classification. A pilot's zone
 * field is never "unavailable" merely because no curated zone matched a
 * valid GPS fix (see ZoneAvailability in lib/driverContext/types.ts) — that
 * distinction only exists on `zone` (ZoneDetail), not on the generic
 * ContextSources metadata, so it has to be read from `zone` directly. Demo
 * accounts (contextSources.zoneRisk classified as "fallback") keep the
 * existing "Demo Data" wording, unchanged.
 *
 * For the non-matched branch, the Russian wording is derived from
 * `zone.availability` (a canonical enum) via
 * lib/i18n/enumLabels.ts's translateZoneAvailability — not by translating
 * `zone.explanation` itself, since that's a pre-formatted English sentence
 * with no guarantee of stable wording.
 */
export function zoneStatusPhrase(meta: FieldMeta, zone: ZoneDetail | undefined, now: Date, language: Language = "en"): string {
  if (classifySpecial(meta) === "fallback") return fieldStatusPhrase("Zone risk", meta, now, language);
  if (!zone) return fieldStatusPhrase("Zone risk", meta, now, language);

  const zoneLabel = translateFieldLabel("Zone risk", language);
  if (zone.availability === "matched") {
    if (language === "ru") {
      return zone.zoneName ? `${zoneLabel}: в реальном времени (SafeHaul Zones) — ${zone.zoneName}.` : `${zoneLabel}: в реальном времени (SafeHaul Zones).`;
    }
    return zone.zoneName ? `Zone risk: Live (SafeHaul Zones) — ${zone.zoneName}.` : "Zone risk: Live (SafeHaul Zones).";
  }
  const explanation = language === "ru" ? translateZoneAvailability(zone.availability, "ru") : zone.explanation;
  return `${zoneLabel}: ${explanation}.`;
}

/**
 * Minimal shape safetyEventsStatusPhrase needs from the API's `liveData` —
 * deliberately narrower than the full liveData response shape so this
 * module doesn't couple to that type's exact fields, only the one it uses.
 */
export interface SafetyEventsSyncInfo {
  lastSyncTime: string | null;
}

/**
 * Safety events gets its own phrase instead of going through
 * fieldStatusPhrase's generic "Cached (provider, X min old)" wording (N2,
 * Phase 5, 2026-08-05 — see docs/data-freshness.md).
 *
 * For every other field, `meta.observedAt` genuinely describes how old the
 * CURRENT READING is. For safetyEvents specifically, `observedAt` is the
 * latest REAL EVENT's timestamp (see assembleSafetyEvents in
 * lib/driverContext/assemble.ts) — using it to mean "how stale is our
 * sync" would describe a long, event-free (i.e. safe) driving stretch as
 * "our data is old/broken," even when the provider sync itself succeeded
 * moments ago. `liveData.lastSyncTime` is the correct signal for provider
 * synchronization recency, so it — not event age — drives this phrase's
 * "cached" wording. The latest event's own timestamp is surfaced
 * separately elsewhere on the dashboard (the "Last event"/"Event time"
 * grid) and is never conflated with sync recency here. A missing/
 * unavailable sync timestamp degrades gracefully (no fabricated age),
 * matching fieldStatusPhrase's own `mins === null` handling — the absence
 * of a sync timestamp must never be read as "the provider hasn't synced."
 */
export function safetyEventsStatusPhrase(
  meta: FieldMeta,
  liveData: SafetyEventsSyncInfo | null,
  now: Date,
  language: Language = "en"
): string {
  if (classifySpecial(meta) !== "cached") return fieldStatusPhrase("Safety events", meta, now, language);

  const label = translateFieldLabel("Safety events", language);
  const provider = providerLabel(meta.provider);
  const syncMins = minutesAgo(liveData?.lastSyncTime ?? null, now);

  if (language === "ru") {
    if (syncMins === null) {
      return provider ? `${label}: кэш (${provider}).` : `${label}: кэш.`;
    }
    return provider
      ? `${label}: синхронизировано ${syncMins} мин назад (${provider}).`
      : `${label}: синхронизировано ${syncMins} мин назад.`;
  }

  if (syncMins === null) {
    return provider ? `Safety events: Cached (${provider}).` : "Safety events: Cached.";
  }
  return provider
    ? `Safety events: Synced ${syncMins} min ago (${provider}).`
    : `Safety events: Synced ${syncMins} min ago.`;
}

const DISCLOSURE_FIELDS: { key: "hos" | "speed" | "weather"; label: string }[] = [
  { key: "hos",     label: "HOS" },
  { key: "speed",   label: "Speed" },
  { key: "weather", label: "Weather" },
];

/**
 * Builds the "what's live vs. cached vs. unavailable vs. demo" disclosure
 * shown for partial_live — generated entirely from contextSources (and,
 * for zone risk, the richer ZoneDetail; for safety events, liveData's sync
 * recency), never hardcoded, so no field can read more or less
 * "live"/"available"/"current" than its actual backend state says it is.
 *
 * `now` defaults to the real current time (unchanged production behavior)
 * but is injectable for deterministic tests, matching the pattern already
 * used by every phrase-building function this composes. `language`
 * defaults to `"en"`, additive/backward-compatible.
 */
export function buildPartialLiveDisclosure(
  sources: ContextSources,
  zone: ZoneDetail | undefined,
  liveData: SafetyEventsSyncInfo | null,
  now: Date = new Date(),
  language: Language = "en"
): string {
  const phrases = [
    safetyEventsStatusPhrase(sources.safetyEvents, liveData, now, language),
    ...DISCLOSURE_FIELDS.map(({ key, label }) => fieldStatusPhrase(label, sources[key], now, language)),
    zoneStatusPhrase(sources.zoneRisk, zone, now, language),
  ];
  return phrases.join(" ");
}

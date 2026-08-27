/**
 * lib/i18n/enumLabels.ts
 *
 * Translation for values that already arrive from the backend as stable
 * canonical enums (RiskLevel, ContextStatus, ZoneAvailability,
 * ContextualSpeedComponentKey). Because the backend field itself is the
 * lookup key — not a pre-formatted English sentence — these translations
 * are fully robust: there is no reverse-parsing or pattern-matching
 * involved, unlike lib/i18n/auditLabels.ts. See lib/riskEngine.ts and
 * lib/driverContext/types.ts for the source-of-truth enum definitions this
 * file mirrors; it does not modify or duplicate their logic, only adds a
 * display label per value per language.
 */

import type { Language } from "./translations";
import type { ContextStatus, ZoneAvailability } from "@/lib/driverContext/types";
import type { ContextualSpeedComponentKey } from "@/lib/riskEngine";

const RISK_LEVEL_LABELS: Record<string, Record<Language, string>> = {
  LOW:      { en: "Low Risk",      ru: "Низкий риск" },
  MEDIUM:   { en: "Medium Risk",   ru: "Средний риск" },
  HIGH:     { en: "High Risk",     ru: "Высокий риск" },
  CRITICAL: { en: "Critical Risk", ru: "Критический риск" },
};

/** Falls back to the HIGH label for an unrecognized level — matches DashboardScreen's existing `LEVEL_CONFIG[result.level] ?? LEVEL_CONFIG.HIGH` fallback behavior. */
export function translateRiskLevel(level: string, language: Language): string {
  return (RISK_LEVEL_LABELS[level] ?? RISK_LEVEL_LABELS.HIGH)[language];
}

const CONTEXT_STATUS_LABELS: Record<ContextStatus, Record<Language, string>> = {
  full_live:    { en: "Fully live",     ru: "Все данные в реальном времени" },
  partial_live: { en: "Partially live", ru: "Частично в реальном времени" },
  demo:         { en: "Public Demo",    ru: "Публичная демо-версия" },
};

export function translateContextStatus(status: ContextStatus, language: Language): string {
  return CONTEXT_STATUS_LABELS[status][language];
}

const ZONE_AVAILABILITY_LABELS: Record<ZoneAvailability, Record<Language, string>> = {
  matched:                 { en: "Inside a monitored risk zone",  ru: "В зоне мониторинга риска" },
  outside_monitored_zones: { en: "Outside monitored risk zones",  ru: "Вне зон мониторинга риска" },
  location_unavailable:    { en: "Location unavailable",          ru: "Местоположение недоступно" },
  location_stale:          { en: "Location data stale",           ru: "Данные о местоположении устарели" },
};

/** Translates by the canonical `availability` enum, deliberately ignoring the pre-formatted English `explanation` string the backend also returns alongside it (see lib/driverContext/types.ts's ZoneDetail). */
export function translateZoneAvailability(availability: ZoneAvailability, language: Language): string {
  return ZONE_AVAILABILITY_LABELS[availability][language];
}

const CONTEXTUAL_SPEED_COMPONENT_LABELS: Record<ContextualSpeedComponentKey, Record<Language, string>> = {
  weather:  { en: "Weather",          ru: "Погода" },
  zone:     { en: "Risk zone",        ru: "Зона риска" },
  fatigue:  { en: "Fatigue",          ru: "Усталость" },
  behavior: { en: "Recent behavior",  ru: "Недавнее поведение" },
};

/** Translates by the component's stable `key`, ignoring its pre-formatted English `label` (lib/riskEngine.ts's calculateSpeedExposure). */
export function translateContextualSpeedComponent(key: ContextualSpeedComponentKey, language: Language): string {
  return CONTEXTUAL_SPEED_COMPONENT_LABELS[key][language];
}

const MISSING_CONTEXT_LABELS: Record<string, Record<Language, string>> = {
  "Weather":   { en: "Weather",   ru: "погоды" },
  "Zone risk": { en: "Zone risk", ru: "зоны риска" },
  "HOS":       { en: "HOS",       ru: "часов работы (HOS)" },
};

/** result.contextualSpeed.missingContext[] is a small fixed English vocabulary (see lib/riskEngine.ts) with no canonical key — exact-match with a safe fallback to the original English string for anything unrecognized. */
export function translateMissingContextItem(item: string, language: Language): string {
  return MISSING_CONTEXT_LABELS[item]?.[language] ?? item;
}

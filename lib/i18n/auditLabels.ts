/**
 * lib/i18n/auditLabels.ts
 *
 * Best-effort, frontend-only translation layer for `/api/audit`'s
 * AuditEvent[] (lib/audit.ts's `AuditEvent`), which — unlike `/api/risk` —
 * returns ONLY preformatted English strings (title/badge/detail/meta), not
 * the canonical values (dangerLevel, event type, raw numbers) that were
 * baked into them. See the Plan Mode report's section B for the full
 * boundary analysis this module implements.
 *
 * Strategy, in order of robustness:
 *  1. Exact-match dictionaries for the small, fixed vocabulary of
 *     badges/titles/detail sentences every builder in lib/auditItems.ts
 *     and app/api/audit/route.ts actually emits (verified by reading both
 *     files) — zero fragility, these strings only change if the backend
 *     builders themselves change.
 *  2. `translateFormattedEventTitle` (lib/i18n/eventTypeLabels.ts) for
 *     driver-event titles, which reverses the Title-Case transform the
 *     backend applies to the canonical type — best-effort, safe fallback.
 *  3. Regex templates for detail/meta strings that embed a real number
 *     (score, percentage, mileage, severity) inside an otherwise fixed
 *     English sentence — captures the number, rebuilds the sentence in
 *     Russian.
 *
 * Anything that doesn't match any rule (raw addresses/zone names, a
 * driver's free-text incident description, an AI-generated inspection
 * summary, an unrecognized future event type) is returned completely
 * unchanged — this module NEVER fabricates a translation and NEVER drops
 * content. It also never touches the underlying AuditEvent objects; it
 * only computes what a component should render for display.
 */

import type { Language } from "./translations";
import { translateFormattedEventTitle } from "./eventTypeLabels";

// ── Badges ──────────────────────────────────────────────────────────────

const BADGE_LABELS: Record<string, string> = {
  "INCIDENT":      "ИНЦИДЕНТ",
  "HIGH ALERT":    "ВЫСОКАЯ ТРЕВОГА",
  "WARNING":       "ПРЕДУПРЕЖДЕНИЕ",
  "NOTICE":        "УВЕДОМЛЕНИЕ",
  "TRIP":          "ПОЕЗДКА",
  "PASSED":        "ПРОЙДЕНО",
  "FAILED":        "НЕ ПРОЙДЕНО",
  "PRE-TRIP":      "ПЕРЕД РЕЙСОМ",
  "LOW RISK":      "НИЗКИЙ РИСК",
  "MEDIUM RISK":   "СРЕДНИЙ РИСК",
  "HIGH RISK":     "ВЫСОКИЙ РИСК",
  "CRITICAL RISK": "КРИТИЧЕСКИЙ РИСК",
};

export function translateAuditBadge(badge: string, language: Language): string {
  if (language === "en") return badge;
  return BADGE_LABELS[badge] ?? badge;
}

// ── Titles ──────────────────────────────────────────────────────────────

const TITLE_LABELS: Record<string, string> = {
  "Incident Report":       "Отчёт об инциденте",
  "Daily Safety Score":    "Ежедневная оценка безопасности",
  "Daily Driving Summary": "Сводка за день",
  "Pre-Trip Inspection":   "Предрейсовый осмотр",
  // Mock/demo-only titles (lib/audit.ts's getMockAuditEvents, shown only
  // behind ?demo=1) — finite and known, so translated exactly like any
  // other fixed title rather than left as an unavoidable remnant.
  "Air Brake Failure — I-16 MM 47":        "Отказ пневмотормозов — трасса I-16, миля 47",
  "Roadside Inspection — Level II":        "Дорожная проверка — уровень II",
  "HOS Log — 30-Min Rest Reminder":        "Журнал часов работы — напоминание об отдыхе (30 мин)",
  "Pre-Trip Inspection — Jacksonville FL": "Предрейсовый осмотр — Джексонвилл, Флорида",
};

/**
 * Tries the fixed-title dictionary first, then falls back to the
 * event-type reverse lookup (for driver-event/safety-event titles built
 * via formatEventType server-side), then to the original English title if
 * neither matches.
 */
export function translateAuditTitle(title: string, language: Language): string {
  if (language === "en") return title;
  return TITLE_LABELS[title] ?? translateFormattedEventTitle(title, language);
}

// ── Detail sentences ────────────────────────────────────────────────────

const DETAIL_EXACT_LABELS: Record<string, string> = {
  "No description provided.":
    "Описание не указано.",
  "Trip logged. Location data not available.":
    "Поездка зафиксирована. Данные о местоположении недоступны.",
  "Route span unavailable — no trustworthy moving observation this day.":
    "Маршрут недоступен — в этот день не было достоверных данных о движении.",
  "Unable to load document.":
    "Не удалось загрузить документ.",
};

interface DetailTemplate {
  pattern: RegExp;
  build: (match: RegExpMatchArray) => string;
}

const DETAIL_TEMPLATES: DetailTemplate[] = [
  {
    pattern: /^Driver safety score: (\d+) out of 100$/,
    build: (m) => `Оценка безопасности водителя: ${m[1]} из 100`,
  },
  {
    pattern: /^Average safety score: (\d+) out of 100$/,
    build: (m) => `Средняя оценка безопасности: ${m[1]} из 100`,
  },
  {
    pattern: /^Severity (\d+)\/5 · Simulated by SafeHaul's demo safety system \(not real telematics\)\.$/,
    build: (m) => `Серьёзность ${m[1]}/5 · Смоделировано демо-системой безопасности SafeHaul (не реальная телематика).`,
  },
  {
    pattern: /^Detected by (.+) onboard telematics\.$/,
    build: (m) => `Обнаружено бортовой телематикой ${m[1]}.`,
  },
];

/**
 * Translates a known fixed sentence or a known numeric template; anything
 * else (joined location/zone names, driver-entered incident text, an
 * AI-generated inspection summary, an unrecognized sentence shape) passes
 * through unchanged — these are either intentionally left untranslated
 * (raw provider/geographic content) or genuinely can't be localized on the
 * frontend (free-form generated text) per the Plan Mode report's section B.
 */
export function translateAuditDetail(detail: string, language: Language): string {
  if (language === "en") return detail;
  if (DETAIL_EXACT_LABELS[detail]) return DETAIL_EXACT_LABELS[detail];
  for (const { pattern, build } of DETAIL_TEMPLATES) {
    const m = detail.match(pattern);
    if (m) return build(m);
  }
  return detail;
}

// ── Meta chips ──────────────────────────────────────────────────────────

const META_EXACT_LABELS: Record<string, string> = {
  "Driver-initiated report":  "Отчёт создан водителем",
  "📍 GPS location recorded": "📍 Зафиксировано местоположение GPS",
  "📍 GPS recorded":          "📍 Зафиксировано GPS",
  "🧪 Demo Data":              "🧪 Демо-данные",
  "📷 Photo analyzed":         "📷 Фото проанализировано",
};

const META_TEMPLATES: DetailTemplate[] = [
  { pattern: /^⚠ Severity (\d+)\/5$/,               build: (m) => `⚠ Серьёзность ${m[1]}/5` },
  { pattern: /^🎯 (\d+)% confidence$/,               build: (m) => `🎯 ${m[1]}% уверенности` },
  { pattern: /^🛣 ([\d.]+) mi$/,                     build: (m) => `🛣 ${m[1]} миль` },
  { pattern: /^🌦 Weather Risk (\d+)%$/,             build: (m) => `🌦 Риск погоды ${m[1]}%` },
  { pattern: /^🗺 Area Risk (\d+)%$/,                build: (m) => `🗺 Риск участка ${m[1]}%` },
  { pattern: /^(\d+) of (\d+) hourly samples$/,      build: (m) => `${m[1]} из ${m[2]} часовых замеров` },
  {
    pattern: /^📡 (.+) · (Stream|Webhook)$/,
    build: (m) => `📡 ${m[1]} · ${m[2] === "Stream" ? "Поток" : "Вебхук"}`,
  },
];

function translateOneMetaChip(chip: string): string {
  if (META_EXACT_LABELS[chip]) return META_EXACT_LABELS[chip];
  for (const { pattern, build } of META_TEMPLATES) {
    const m = chip.match(pattern);
    if (m) return build(m);
  }
  return chip;
}

/** Maps every chip in an AuditEvent.meta array through the single-chip translator above; English is a no-op pass-through. */
export function translateAuditMeta(meta: string[], language: Language): string[] {
  if (language === "en") return meta;
  return meta.map(translateOneMetaChip);
}

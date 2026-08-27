/**
 * lib/i18n/eventTypeLabels.ts
 *
 * Translates DriverEvent/SafetyEvent canonical type strings (e.g.
 * "harsh_braking", "following_distance") into driver-facing labels.
 *
 * Two entry points, because callers hold the data at two different stages:
 *  - `translateEventType(rawType, language)` — used where the raw
 *    canonical type string is still available (e.g. DashboardScreen's
 *    `riskData.liveData.lastEventType`). This is the robust path: exact
 *    match against the known canonical vocabulary, safe fallback to the
 *    same Title Case formatting the backend itself uses
 *    (app/api/audit/route.ts's formatEventType) for anything unrecognized.
 *  - `translateFormattedEventTitle(title, language)` — used where only the
 *    already Title-Cased English string survives (app/api/audit's
 *    AuditEvent.title has no raw `type` field left once mapped to a
 *    Stamped event — see lib/i18n/auditLabels.ts). Mechanically reverses
 *    formatEventType's `snake_case -> Title Case` transform (lowercase,
 *    spaces -> underscores) and looks that up against the same table. This
 *    is best-effort, not guaranteed: a brand-new canonical type added to
 *    the DB without a matching entry here simply falls through to the
 *    original English title, never a broken/blank one.
 */

import type { Language } from "./translations";

const EVENT_TYPE_LABELS: Record<string, string> = {
  harsh_braking:              "Резкое торможение",
  harsh_turn:                 "Резкий поворот",
  harsh_accel:                "Резкое ускорение",
  harsh_maneuver:             "Резкий манёвр",
  speeding:                   "Превышение скорости",
  mobile_usage:               "Использование телефона",
  following_distance:         "Небезопасная дистанция",
  rolling_stop:                "Неполная остановка",
  crash:                      "ДТП",
  forward_collision_warning:  "Предупреждение о столкновении",
  high_speed_power_loss:      "Потеря мощности на высокой скорости",
  inattentive_driving:        "Невнимательное вождение",
};

/** Mirrors app/api/audit/route.ts's formatEventType() exactly, so the English fallback path here matches the backend's own formatting byte-for-byte. */
function formatEventTypeEnglish(rawType: string): string {
  return rawType.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Robust path — use whenever the raw canonical type string is available. */
export function translateEventType(rawType: string, language: Language): string {
  if (language === "en") return formatEventTypeEnglish(rawType);
  return EVENT_TYPE_LABELS[rawType] ?? formatEventTypeEnglish(rawType);
}

/**
 * Best-effort path — use only when the raw type is unavailable and all
 * that survives is the already Title-Cased English string (e.g. an
 * AuditEvent.title built server-side by app/api/audit/route.ts). Reverses
 * the Title Case -> snake_case transform for lookup; on any miss, returns
 * the original title unchanged rather than a broken guess.
 */
export function translateFormattedEventTitle(title: string, language: Language): string {
  if (language === "en") return title;
  const rawType = title.trim().toLowerCase().split(/\s+/).join("_");
  return EVENT_TYPE_LABELS[rawType] ?? title;
}

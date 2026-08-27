/**
 * lib/i18n/factorLabels.ts
 *
 * Translates lib/riskEngine.ts's `RiskOutput.factors[].name` — a fixed,
 * finite English vocabulary (the `labelMap` in calculateRisk()'s
 * buildFactors()) with no stable key surviving into the API response, only
 * the label itself. Exact-string lookup with a safe fallback to the
 * original English name for anything unrecognized (e.g. if the engine
 * later adds a new factor without a matching translation here) — a factor
 * name must never render blank.
 */

import type { Language } from "./translations";

const FACTOR_NAME_LABELS: Record<string, string> = {
  "Harsh Braking":      "Резкое торможение",
  "Speeding":           "Превышение скорости",
  "Harsh Maneuver":     "Резкий манёвр",
  "Distracted Driving": "Невнимательное вождение",
  "Mechanical Risk":    "Механический риск",
  "Fatigue":            "Усталость",
  "Weather":            "Погода",
  "Zone Risk":          "Риск участка",
  "Following Distance": "Небезопасная дистанция",
  "Rolling Stop":       "Неполная остановка",
};

export function translateFactorName(name: string, language: Language): string {
  if (language === "en") return name;
  return FACTOR_NAME_LABELS[name] ?? name;
}

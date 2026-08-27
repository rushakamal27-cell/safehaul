/**
 * lib/i18n/recommendationLabels.ts
 *
 * Translates lib/riskEngine.ts's `RiskOutput.recommendations[]` — a fixed,
 * finite set of at most 9 literal English sentences (buildRecommendations()
 * — verified no driver-specific value is ever interpolated into any of
 * them). Exact-string lookup with a safe fallback to the original English
 * sentence for anything unrecognized, so a future engine change that adds
 * a new recommendation degrades gracefully (shows in English) rather than
 * rendering blank or throwing.
 */

import type { Language } from "./translations";

const RECOMMENDATION_LABELS: Record<string, string> = {
  "Consider a rest break soon.":
    "Скоро стоит сделать перерыв на отдых.",
  "Use extra caution due to current weather conditions.":
    "Будьте особенно осторожны из-за текущих погодных условий.",
  "Reduce speed and maintain a safe following distance.":
    "Снизьте скорость и держите безопасную дистанцию.",
  "Proceed carefully in the current risk zone.":
    "Будьте осторожны — вы в зоне повышенного риска.",
  "Increase following distance to avoid sudden stops.":
    "Увеличьте дистанцию, чтобы избежать резких остановок.",
  "Smooth acceleration and turns improve safety and fuel efficiency.":
    "Плавное ускорение и повороты повышают безопасность и экономят топливо.",
  "Put the phone away — distracted driving is a leading cause of crashes.":
    "Уберите телефон — невнимательность за рулём — одна из главных причин ДТП.",
  "High-speed power loss detected — pull over safely and inspect the vehicle.":
    "Обнаружена потеря мощности на высокой скорости — остановитесь и проверьте автомобиль.",
  "Come to a complete stop at stop signs and red lights.":
    "Полностью останавливайтесь на знаках «Стоп» и красный свет.",
};

export function translateRecommendation(text: string, language: Language): string {
  if (language === "en") return text;
  return RECOMMENDATION_LABELS[text] ?? text;
}

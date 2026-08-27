/**
 * lib/recommendationDisplay.ts
 *
 * Pure classification of a risk-engine recommendation string (lib/riskEngine.ts's
 * RiskOutput.recommendations) into a display category + title. Extracted
 * from components/screens/DashboardScreen.tsx's parseRecommendation so this
 * keyword-matching logic is unit-testable — .tsx component files have no
 * test harness in this repo (same rationale as lib/dashboardDisclosure.ts,
 * Phase 5 N2). The actual icon (a React element) stays in DashboardScreen.tsx,
 * which maps `category` to a lucide-react component — keeping this module
 * free of JSX/React dependencies.
 *
 * Order matters: more specific matches must be checked before more generic
 * ones that would otherwise shadow them. Phase 6A (2026-08-xx) added the
 * "trafficControl" branch (stop sign / red light) BEFORE the existing
 * generic "braking" branch (brake/stop) — both match the substring "stop",
 * so a stop-sign recommendation would otherwise fall into "Braking".
 *
 * Fixed as part of the same phase (pre-existing, not introduced by the
 * extraction): "speed" is a substring of both "following distance"-free
 * messages that actually belong to more specific categories — "Increase
 * following distance to avoid sudden stops." (contains "stop", the harsh-
 * braking recommendation) and "High-speed power loss..." (contains
 * "speed" via "High-speed", the mechanical/vehicle recommendation) — so
 * trafficControl/braking/vehicle are now checked BEFORE the generic
 * "speed" branch. Confirmed this doesn't change any other message's
 * classification (see lib/__tests__/recommendationDisplay.test.ts).
 *
 * Localization (2026-08-27): classification itself ALWAYS runs against the
 * engine's original English `rec` string, regardless of display language —
 * the keyword matching above is inherently coupled to English wording, and
 * translating `rec` before classifying would break it. `classifyRecommendation`
 * now takes an optional `language` (default `"en"`) purely to select which
 * language the returned `category`'s `title` is displayed in, via
 * lib/i18n/translations.ts's fixed category-title dictionary — additive,
 * backward-compatible, existing call sites/tests unaffected.
 */

import { translate, type Language, type TranslationKey } from "./i18n/translations";

export type RecommendationCategory =
  | "fatigue"
  | "weather"
  | "speed"
  | "zoneAlert"
  | "distraction"
  | "trafficControl"
  | "braking"
  | "vehicle"
  | "drivingStyle"
  | "advisory";

export interface RecommendationClassification {
  category: RecommendationCategory;
  title: string;
}

const CATEGORY_TITLE_KEYS: Record<RecommendationCategory, TranslationKey> = {
  fatigue:        "recCategoryFatigue",
  weather:        "recCategoryWeather",
  speed:          "recCategorySpeed",
  zoneAlert:      "recCategoryZoneAlert",
  distraction:    "recCategoryDistraction",
  trafficControl: "recCategoryTrafficControl",
  braking:        "recCategoryBraking",
  vehicle:        "recCategoryVehicle",
  drivingStyle:   "recCategoryDrivingStyle",
  advisory:       "recCategoryAdvisory",
};

/** Pure — never throws, always returns a classification (falls back to "advisory"/"Advisory" for anything unmatched). Classification runs on the original English `rec` text regardless of `language` — see file header. */
export function classifyRecommendation(rec: string, language: Language = "en"): RecommendationClassification {
  const lower = rec.toLowerCase();

  let category: RecommendationCategory;
  if (lower.includes("rest") || lower.includes("break") || lower.includes("fatigue")) {
    category = "fatigue";
  } else if (lower.includes("weather") || lower.includes("caution") || lower.includes("condition")) {
    category = "weather";
    // trafficControl/braking/vehicle are checked here, before the generic
    // "speed" branch below, specifically because "Increase following
    // distance to avoid sudden stops." and "High-speed power loss..." both
    // contain "speed"-branch-matching substrings ("following distance" is
    // not present in the first, but "stop" is; "speed" is present in the
    // second via "High-speed") — see the file header.
  } else if (lower.includes("stop sign") || lower.includes("red light") || lower.includes("traffic control")) {
    category = "trafficControl";
  } else if (lower.includes("brake") || lower.includes("stop")) {
    category = "braking";
  } else if (lower.includes("pull over") || lower.includes("power loss") || lower.includes("inspect")) {
    category = "vehicle";
  } else if (lower.includes("speed") || lower.includes("following distance")) {
    category = "speed";
  } else if (lower.includes("zone") || lower.includes("area")) {
    category = "zoneAlert";
  } else if (lower.includes("phone") || lower.includes("distract")) {
    category = "distraction";
  } else if (lower.includes("smooth") || lower.includes("accel") || lower.includes("maneuver")) {
    category = "drivingStyle";
  } else {
    category = "advisory";
  }

  return { category, title: translate(CATEGORY_TITLE_KEYS[category], language) };
}

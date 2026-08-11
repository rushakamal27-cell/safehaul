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
 */

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

/** Pure — never throws, always returns a classification (falls back to "advisory"/"Advisory" for anything unmatched). */
export function classifyRecommendation(rec: string): RecommendationClassification {
  const lower = rec.toLowerCase();

  if (lower.includes("rest") || lower.includes("break") || lower.includes("fatigue")) {
    return { category: "fatigue", title: "Fatigue" };
  }
  if (lower.includes("weather") || lower.includes("caution") || lower.includes("condition")) {
    return { category: "weather", title: "Weather" };
  }
  // trafficControl/braking/vehicle are checked here, before the generic
  // "speed" branch below, specifically because "Increase following
  // distance to avoid sudden stops." and "High-speed power loss..." both
  // contain "speed"-branch-matching substrings ("following distance" is
  // not present in the first, but "stop" is; "speed" is present in the
  // second via "High-speed") — see the file header.
  if (lower.includes("stop sign") || lower.includes("red light") || lower.includes("traffic control")) {
    return { category: "trafficControl", title: "Traffic Control" };
  }
  if (lower.includes("brake") || lower.includes("stop")) {
    return { category: "braking", title: "Braking" };
  }
  if (lower.includes("pull over") || lower.includes("power loss") || lower.includes("inspect")) {
    return { category: "vehicle", title: "Vehicle" };
  }
  if (lower.includes("speed") || lower.includes("following distance")) {
    return { category: "speed", title: "Speed" };
  }
  if (lower.includes("zone") || lower.includes("area")) {
    return { category: "zoneAlert", title: "Zone Alert" };
  }
  if (lower.includes("phone") || lower.includes("distract")) {
    return { category: "distraction", title: "Distraction" };
  }
  if (lower.includes("smooth") || lower.includes("accel") || lower.includes("maneuver")) {
    return { category: "drivingStyle", title: "Driving Style" };
  }
  return { category: "advisory", title: "Advisory" };
}

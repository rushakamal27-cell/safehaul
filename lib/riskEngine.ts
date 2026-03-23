export interface RiskInput {
  safetyEvents: { type: string; severity: number }[];
  hosHours: number;
  weatherRisk: number; // 0–1
  zoneRisk: number;    // 0–1
  speed: number;       // mph
}

export interface RiskFactor {
  name: string;
  impact: number; // percentage of total penalty (0–100)
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskOutput {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Penalty calculators
// ---------------------------------------------------------------------------

function calcSafetyEventPenalties(
  events: RiskInput["safetyEvents"]
): { harshBraking: number; speeding: number } {
  let harshBraking = 0;
  let speeding = 0;

  for (const event of events) {
    if (event.type === "harsh_braking") harshBraking += 2 * event.severity;
    else if (event.type === "speeding") speeding += 3 * event.severity;
  }

  return { harshBraking, speeding };
}

function calcFatiguePenalty(hosHours: number): number {
  return hosHours > 8 ? (hosHours - 8) * 2 : 0;
}

function calcWeatherPenalty(weatherRisk: number): number {
  return weatherRisk * 20;
}

function calcZonePenalty(zoneRisk: number): number {
  return zoneRisk * 15;
}

function calcSpeedPenalty(speed: number): number {
  return speed > 70 ? (speed - 70) * 0.5 : 0;
}

// ---------------------------------------------------------------------------
// Level thresholds
// ---------------------------------------------------------------------------

function resolveLevel(score: number): RiskLevel {
  if (score >= 75) return "LOW";
  if (score >= 50) return "MEDIUM";
  if (score >= 25) return "HIGH";
  return "CRITICAL";
}

// ---------------------------------------------------------------------------
// Explainability — convert raw penalties to percentage factors
// ---------------------------------------------------------------------------

function buildFactors(penalties: Record<string, number>): RiskFactor[] {
  const totalPenalty = Object.values(penalties).reduce((sum, v) => sum + v, 0);

  if (totalPenalty === 0) return [];

  const labelMap: Record<string, string> = {
    harshBraking: "Harsh Braking",
    speeding: "Speeding",
    fatigue: "Fatigue",
    weather: "Weather",
    zone: "Zone Risk",
    speed: "Excessive Speed",
  };

  return Object.entries(penalties)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({
      name: labelMap[key] ?? key,
      impact: Math.round((value / totalPenalty) * 100),
    }))
    .sort((a, b) => b.impact - a.impact);
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function buildRecommendations(
  input: RiskInput,
  penalties: Record<string, number>,
  totalPenalty: number
): string[] {
  const recs: string[] = [];

  const fatigueShare = totalPenalty > 0 ? penalties.fatigue / totalPenalty : 0;
  if (fatigueShare >= 0.2 || input.hosHours > 10) {
    recs.push("Take a rest break — fatigue is significantly increasing your risk.");
  }

  if (input.weatherRisk > 0.5) {
    recs.push("Drive cautiously due to adverse weather conditions.");
  }

  const speedingPenalty = penalties.speeding + penalties.speed;
  if (speedingPenalty > 0) {
    recs.push("Reduce speed to improve your safety score.");
  }

  if (input.zoneRisk > 0.5) {
    recs.push("Exercise caution — you are in a high-risk zone.");
  }

  if (penalties.harshBraking > 0) {
    recs.push("Increase following distance to reduce harsh braking events.");
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function calculateRisk(input: RiskInput): RiskOutput {
  const { harshBraking, speeding } = calcSafetyEventPenalties(input.safetyEvents);
  const fatigue = calcFatiguePenalty(input.hosHours);
  const weather = calcWeatherPenalty(input.weatherRisk);
  const zone = calcZonePenalty(input.zoneRisk);
  const speed = calcSpeedPenalty(input.speed);

  const penalties: Record<string, number> = {
    harshBraking,
    speeding,
    fatigue,
    weather,
    zone,
    speed,
  };

  const totalPenalty = Object.values(penalties).reduce((sum, v) => sum + v, 0);
  const rawScore = 100 - totalPenalty;
  const score = Math.min(100, Math.max(0, Math.round(rawScore)));

  return {
    score,
    level: resolveLevel(score),
    factors: buildFactors(penalties),
    recommendations: buildRecommendations(input, penalties, totalPenalty),
  };
}

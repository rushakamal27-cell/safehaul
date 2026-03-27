export interface RiskInput {
  safetyEvents: { type: string; severity: number }[];
  hosHours: number;
  weatherRisk: number; // 0–1
  zoneRisk: number;    // 0–1
  speed: number;       // mph
}

export interface RiskFactor {
  name: string;
  impact: number; // percentage of total penalty, sums to 100
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RiskTrend = "IMPROVING" | "STABLE" | "WORSENING";

export interface RiskOutput {
  score: number;
  level: RiskLevel;
  trend: RiskTrend;
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
// Explainability — largest-remainder rounding so factors sum to exactly 100
// ---------------------------------------------------------------------------

function buildFactors(displayPenalties: Record<string, number>): RiskFactor[] {
  const totalPenalty = Object.values(displayPenalties).reduce((sum, v) => sum + v, 0);

  if (totalPenalty === 0) return [];

  const labelMap: Record<string, string> = {
    harshBraking: "Harsh Braking",
    speeding:     "Speeding",
    fatigue:      "Fatigue",
    weather:      "Weather",
    zone:         "Zone Risk",
  };

  // Compute exact float percentages, keep only non-zero entries
  const entries = Object.entries(displayPenalties)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({
      name:     labelMap[key] ?? key,
      exact:    (value / totalPenalty) * 100,
      floored:  Math.floor((value / totalPenalty) * 100),
      remainder: ((value / totalPenalty) * 100) % 1,
    }));

  // Distribute leftover percentage points to entries with largest fractional remainders
  const distributed = 100 - entries.reduce((sum, e) => sum + e.floored, 0);
  entries.sort((a, b) => b.remainder - a.remainder);
  entries.forEach((e, i) => { e.floored += i < distributed ? 1 : 0; });

  return entries
    .map(({ name, floored }) => ({ name, impact: floored }))
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
    recs.push("Consider a rest break soon.");
  }

  if (input.weatherRisk > 0.5) {
    recs.push("Use extra caution due to current weather conditions.");
  }

  const speedingPenalty = penalties.speeding + penalties.speed;
  if (speedingPenalty > 0) {
    recs.push("Reduce speed and maintain a safe following distance.");
  }

  if (input.zoneRisk > 0.5) {
    recs.push("Proceed carefully in the current risk zone.");
  }

  if (penalties.harshBraking > 0) {
    recs.push("Increase following distance to avoid sudden stops.");
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
  const zone    = calcZonePenalty(input.zoneRisk);
  const speed   = calcSpeedPenalty(input.speed);

  // All raw penalties — used for score calculation and recommendations
  const rawPenalties: Record<string, number> = {
    harshBraking,
    speeding,
    fatigue,
    weather,
    zone,
    speed,
  };

  // Display penalties — speeding event + excess speed merged into one "speeding" factor
  const displayPenalties: Record<string, number> = {
    harshBraking,
    speeding: speeding + speed,
    fatigue,
    weather,
    zone,
  };

  const totalPenalty = Object.values(rawPenalties).reduce((sum, v) => sum + v, 0);
  const rawScore     = 100 - totalPenalty;
  const score        = Math.min(100, Math.max(0, Math.round(rawScore)));

  return {
    score,
    level:           resolveLevel(score),
    trend:           "STABLE",
    factors:         buildFactors(displayPenalties),
    recommendations: buildRecommendations(input, rawPenalties, totalPenalty),
  };
}

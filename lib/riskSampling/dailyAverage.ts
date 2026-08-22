/**
 * lib/riskSampling/dailyAverage.ts
 *
 * Pure arithmetic mean over whatever valid samples actually exist for a day
 * — the Part 3 "critical denominator rule": NEVER divide by an assumed
 * slot count (e.g. 24 hourly slots, or a fixed number of DriverObservation
 * readings). A missing sample is simply absent from the input array; it is
 * never converted to a 0 and never inflates the denominator. Used for the
 * daily Safety Score average (over SafetyScoreSample.score) AND, with the
 * same function, the daily weather/zone risk averages (over
 * DriverObservation.weatherRisk / .zoneRisk) — all three are "mean of
 * whatever valid readings existed," just over different inputs.
 */

export interface DailyAverageResult {
  average: number;
  sampleCount: number;
}

/** Returns null (never a fabricated 0-sample average) when `values` is empty — the "no valid data this day" case, which callers must render as unavailable/omitted, not as a score/risk of 0. */
export function computeDailyAverage(values: number[]): DailyAverageResult | null {
  if (values.length === 0) return null;
  const sum = values.reduce((total, v) => total + v, 0);
  return { average: sum / values.length, sampleCount: values.length };
}

/**
 * lib/complianceScoreAverage.ts
 *
 * Pure running-mean math for ComplianceScore.score — the daily aggregation
 * of every /api/risk calculation's result.score for a driver's UTC calendar
 * day. Deliberately separate from lib/riskEngine.ts: this module has no
 * opinion on how a single score is computed, only on how repeated same-day
 * scores are folded into one running average.
 *
 * Uses the incremental-mean identity (mathematically equivalent to summing
 * every score and dividing by the count, without needing to store the
 * individual samples or a running sum):
 *
 *   newAverage = oldAverage + (newScore - oldAverage) / newSampleCount
 *
 * NOT `(oldAverage + newScore) / 2` — that formula silently re-weights every
 * prior sample down to 50% each time a new one arrives, which is only
 * correct for the second sample and wrong for every one after that.
 */

export interface RunningAverage {
  average: number;
  sampleCount: number;
}

export function nextRunningAverage(
  previousAverage: number,
  previousSampleCount: number,
  newScore: number
): RunningAverage {
  const sampleCount = previousSampleCount + 1;
  const average = previousAverage + (newScore - previousAverage) / sampleCount;
  return { average, sampleCount };
}

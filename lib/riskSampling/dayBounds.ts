/**
 * lib/riskSampling/dayBounds.ts
 *
 * Pure UTC calendar-day boundary helpers for the hourly/daily derived-risk
 * pipeline (Part 8 — UTC calendar day, no driver-timezone inference).
 * Distinct from lib/todaySummary.ts::utcDayBounds (today's bounds, used for
 * the live Heads-Up mileage window) — dailyFinalization runs shortly after
 * midnight and needs *yesterday's* bounds, not today's.
 */

/** [start, end) bounds for the UTC calendar day immediately before `now`'s UTC day. `start` is inclusive, `end` (next day's midnight) is exclusive. */
export function utcPreviousDayBounds(now: Date): { start: Date; end: Date } {
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const start = new Date(todayStart);
  start.setUTCDate(start.getUTCDate() - 1);
  return { start, end: todayStart };
}

/** UTC-hour-aligned bucket for `now` (minutes/seconds/ms zeroed) — the hourly sampling slot a given instant belongs to. */
export function utcHourBucket(now: Date): Date {
  const bucket = new Date(now);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/** "YYYY-MM-DD" UTC day key for a Date — used to correlate rows across models that key on different fields (e.g. legacy ComplianceScore.date vs. Trip.startedAt) without assuming they share a column name. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

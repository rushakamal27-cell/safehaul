/**
 * lib/riskSampling/routeSpan.ts
 *
 * Pure derivation of a Daily Driving Summary's "observed route span" (Part
 * 4) from a day's DriverObservation rows — the earliest and latest reading
 * that show genuine movement, NOT a reconstruction of trip chronology and
 * NOT the Samsara Trips API (confirmed not to exist in this API generation
 * — see lib/providers/samsara/vehicleStats.ts). Deliberately simple: no
 * clustering, no stop-detection, no multi-trip segmentation.
 */

/** Conservative movement threshold (mph). Below this, a reading is treated as parked/idling/GPS jitter, not "the vehicle was moving" — deliberately simple (a single fixed threshold, not a sustained-duration or acceleration-based heuristic), per Part 4's explicit "do not invent a sophisticated trip-detection algorithm." */
export const MOVEMENT_SPEED_THRESHOLD_MPH = 5;

export interface ObservationForRouteSpan {
  observedAt: Date;
  latitude: number | null;
  longitude: number | null;
  speedMph: number | null;
  locationLabel: string | null;
}

export interface RouteSpanPoint {
  latitude: number;
  longitude: number;
  observedAt: Date;
  locationLabel: string | null;
}

export interface RouteSpanResult {
  available: boolean;
  start: RouteSpanPoint | null;
  end: RouteSpanPoint | null;
}

function hasCoords(
  o: ObservationForRouteSpan
): o is ObservationForRouteSpan & { latitude: number; longitude: number } {
  return o.latitude !== null && o.longitude !== null;
}

function toPoint(o: ObservationForRouteSpan & { latitude: number; longitude: number }): RouteSpanPoint {
  return { latitude: o.latitude, longitude: o.longitude, observedAt: o.observedAt, locationLabel: o.locationLabel };
}

/**
 * Preferred pool is observations with valid coordinates AND speed at/above
 * MOVEMENT_SPEED_THRESHOLD_MPH ("genuine movement"). Only when that pool is
 * completely empty (no defensible moving reading anywhere in the day) does
 * this fall back to any observation with valid coordinates, regardless of
 * speed — still real, still fresh-enough-to-have-been-captured GPS, just
 * without a movement guarantee. If even that fallback pool is empty (no
 * usable coordinates at all that day), `available` is false and start/end
 * are both null — never a fabricated origin/destination.
 */
export function deriveRouteSpan(observations: ObservationForRouteSpan[]): RouteSpanResult {
  const withCoords = observations.filter(hasCoords);
  const moving = withCoords.filter((o) => o.speedMph !== null && o.speedMph >= MOVEMENT_SPEED_THRESHOLD_MPH);
  const pool = moving.length > 0 ? moving : withCoords;

  if (pool.length === 0) return { available: false, start: null, end: null };

  const sorted = [...pool].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  return {
    available: true,
    start: toPoint(sorted[0]),
    end: toPoint(sorted[sorted.length - 1]),
  };
}

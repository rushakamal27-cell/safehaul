/**
 * lib/providers/zones/zoneRisk.ts
 *
 * Phase 3 — Real Zone Risk. Pure nearest-zone matching against the static
 * dataset in zoneData.ts — no network, no database, no async I/O, so this
 * has none of the timeout/AbortController machinery the Samsara/weather
 * fetchers need. See lib/driverContext/assemble.ts::assembleZoneRisk for
 * how this is gated on fresh real GPS for pilot drivers.
 */

import { ZONE_DATA, type ZoneDefinition } from "./zoneData";

const EARTH_RADIUS_MILES = 3958.8;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Pure — haversine great-circle distance in miles between two coordinates. */
export function haversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

export interface ZoneMatch {
  zone: ZoneDefinition;
  distanceMiles: number;
}

/**
 * Pure — nearest zone whose radius contains the given coordinates, or null
 * if the point falls outside every defined zone. When multiple zones'
 * radii overlap the point, the closest-by-distance zone wins (not
 * first-in-list), so dataset ordering never affects the result. Boundary is
 * inclusive (`<=`), consistent with classifyLocationFreshness's convention
 * elsewhere in this codebase.
 */
export function matchZone(
  latitude: number,
  longitude: number,
  zones: ZoneDefinition[] = ZONE_DATA
): ZoneMatch | null {
  let best: ZoneMatch | null = null;

  for (const zone of zones) {
    const distanceMiles = haversineDistanceMiles(latitude, longitude, zone.latitude, zone.longitude);
    if (distanceMiles <= zone.radiusMiles && (!best || distanceMiles < best.distanceMiles)) {
      best = { zone, distanceMiles };
    }
  }

  return best;
}

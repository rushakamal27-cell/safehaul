/**
 * lib/driverContext/types.ts
 *
 * Provider-neutral normalized representation of a driver's current
 * operational context. Each field separates its value from four pieces of
 * metadata: where it came from (origin), how fresh/available it is (state),
 * which provider supplied it, and when it was observed.
 *
 * Scope: the original five fields (safetyEvents, hos, speed, weather,
 * zoneRisk) are the ones the risk engine consumes. `location` (added in
 * Phase 1 — Real GPS) is tracked here for transparency and future
 * consumers but intentionally does NOT back a RiskInput field yet and is
 * NOT part of deriveContextStatus's full_live/partial_live computation —
 * see lib/driverContext/contextStatus.ts and lib/driverContext/assemble.ts.
 *
 * Valid origin/state combinations:
 *   observed  + fresh|cached   → a real provider supplied this value
 *   simulated + fresh          → intentional demo mode (no real source expected)
 *   simulated + fallback       → a real source is expected but unavailable now
 *   estimated + fresh|cached   → derived from other real inputs (reserved, unused today)
 *   null      + unavailable    → no value could be produced; value is null
 *
 * Disallowed: origin "observed" paired with state "fallback" or a null
 * value; state "fresh"/"cached" with a null observedAt; state "unavailable"
 * with a non-null value.
 */

export type FieldOrigin = "observed" | "estimated" | "simulated";
/** One of four freshness/availability vocabularies in this codebase — see docs/data-freshness.md for the full cross-reference (LocationState, ZoneAvailability, HosDetail.status are the others, each with their own value set and thresholds). */
export type FieldState = "fresh" | "cached" | "fallback" | "unavailable";
/** "internal" marks simulated/demo data; "internal_geofence" (Phase 3) marks a real match against SafeHaul's own bundled zone dataset — kept distinct so a real pilot result is never confused with a mock one. */
export type ProviderId = "samsara" | "openweather" | "internal" | "internal_geofence" | null;

export interface DriverContextField<T> {
  value: T | null;
  origin: FieldOrigin | null;
  state: FieldState;
  provider: ProviderId;
  observedAt: string | null;
}

export interface DriverContextSafetyEvent {
  type: string;
  severity: number;
}

export interface DriverContextCoordinates {
  latitude: number;
  longitude: number;
}

export interface DriverContext {
  driverId: string;
  safetyEvents: DriverContextField<DriverContextSafetyEvent[]>;
  hos: DriverContextField<number>;
  speed: DriverContextField<number>;
  weather: DriverContextField<number>;
  zoneRisk: DriverContextField<number>;
  location: DriverContextField<DriverContextCoordinates>;
}

/** DriverContextField metadata with the value stripped — what's safe to expose over the API without duplicating lib/riskEngine's `input`. */
export interface ContextSourceMeta {
  origin: FieldOrigin | null;
  state: FieldState;
  provider: ProviderId;
  observedAt: string | null;
}

export interface ContextSources {
  safetyEvents: ContextSourceMeta;
  hos: ContextSourceMeta;
  speed: ContextSourceMeta;
  weather: ContextSourceMeta;
  zoneRisk: ContextSourceMeta;
  location: ContextSourceMeta;
}

/**
 * Backend-derived summary of how truthful/complete the current score inputs
 * are — independent of `dataSource`, which only says whether the driver is
 * on a real pilot provider path. See lib/driverContext/contextStatus.ts for
 * the derivation rules.
 */
export type ContextStatus = "full_live" | "partial_live" | "demo";

/**
 * Transparency-only breakdown of the driver's current HOS state, exposed
 * alongside (not instead of) DriverContext.hos. `hos.value` (the scalar fed
 * to the risk engine via toRiskInput) is shiftHoursUsed — see
 * lib/providers/samsara/hos.ts for why that field, not drivingHoursUsed,
 * matches the risk engine's existing fatigue-penalty semantics.
 *
 * drivingHoursUsed is currently always null: Samsara's HOS clocks endpoint
 * reports remaining driving time, not time already used, and deriving "used"
 * from a fixed daily limit would be a guess, not an observed value — see the
 * TODO in lib/providers/samsara/hos.ts. Left null rather than fabricated.
 */
export interface HosDetail {
  drivingHoursUsed: number | null;
  drivingHoursRemaining: number | null;
  shiftHoursUsed: number | null;
  /** Own 3-value vocabulary, distinct from FieldState/LocationState/ZoneAvailability — threshold in lib/providers/samsara/hos.ts. See docs/data-freshness.md. */
  status: "available" | "unavailable" | "stale";
  source: "samsara" | "mock" | "none";
  updatedAt: string | null;
}

/**
 * Trust-classification for a location reading. Distinct from FieldState
 * above (which describes DriverContextField in general) — this is the
 * specific three-state vocabulary Phase 1 (Real GPS) uses for location:
 * a pilot reading is always exactly one of these, never a silent mock
 * fallback. See lib/driverContext/assemble.ts::classifyLocationFreshness
 * for the threshold logic and lib/driverContext/types.ts's DriverContext.location
 * comment for why this doesn't yet affect contextStatus.
 * See docs/data-freshness.md for how this relates to FieldState/ZoneAvailability/HosDetail.status.
 */
export type LocationState = "fresh" | "stale" | "unavailable";

/** How the current vehicle ID was resolved — see lib/providers/samsara/vehicleId.ts. */
export type VehicleIdSource = "provider_mapping" | "driver_event" | "unavailable";

/**
 * Transparency-only breakdown of a pilot driver's (or demo driver's
 * simulated) current vehicle location — exposed alongside (not instead of)
 * DriverContext.location, the same relationship HosDetail has with
 * DriverContext.hos. `latitude`/`longitude` here are the same values as
 * DriverContext.location.value; this block additionally carries
 * provenance/debugging fields the RiskInput-facing DriverContext doesn't
 * need (vehicleIdSource, heading, speed, formattedLocation, etc.).
 *
 * `state: "stale"` preserves real coordinates for transparency but must
 * never be presented as current position — see Phase 1 plan Task 5.
 * `state: "unavailable"` always pairs with null latitude/longitude; pilots
 * never receive mock coordinates here (non-pilots do, with `source: "none"`
 * and simulated provenance surfaced via ContextSources instead).
 */
export interface VehicleLocation {
  latitude: number | null;
  longitude: number | null;
  observedAt: string | null;
  fetchedAt: string;
  provider: "samsara" | null;
  providerVehicleId: string | null;
  vehicleIdSource: VehicleIdSource;
  state: LocationState;
  source: "vehicle_stats" | "none";
  vehicleName?: string | null;
  headingDegrees?: number | null;
  speedMilesPerHour?: number | null;
  isEcuSpeed?: boolean | null;
  formattedLocation?: string | null;
}

/**
 * Transparency-only breakdown of a driver's current weather (Phase 2 —
 * Weather from Real Vehicle GPS) — same relationship to DriverContext.weather
 * that VehicleLocation has to DriverContext.location.
 *
 * For a pilot, `latitude`/`longitude` are the coordinates a weather request
 * was actually made with — null whenever no request was made at all (GPS
 * was stale/unavailable), populated even on a failed request (GPS was
 * fresh, the OpenWeatherMap call itself failed) for debugging transparency.
 * `locationState`/`locationObservedAt` always reflect the underlying GPS
 * reading's own state, independent of whether weather succeeded — this is
 * what makes "why is pilot weather unavailable" answerable without cross-
 * referencing DriverContext.location separately.
 *
 * `status: "unavailable"` always pairs with `weatherRisk: null` and
 * `origin: null` — a pilot's weather is never `origin: "simulated"`; only
 * demo drivers can have simulated weather (their scenario-value fallback,
 * unchanged from before this phase).
 */
export interface WeatherDetail {
  weatherRisk: number | null;
  status: "available" | "unavailable";
  origin: "observed" | "simulated" | null;
  provider: "openweather" | null;
  /** OpenWeatherMap's own observation time (its `dt` field), never the request time. */
  observedAt: string | null;
  fetchedAt: string;
  latitude: number | null;
  longitude: number | null;
  locationState: LocationState | null;
  locationObservedAt: string | null;
  conditionSummary: string | null;
}

/**
 * Distinguishes *why* zoneRisk has (or lacks) a curated-zone match, so a
 * valid GPS reading with no monitored-zone coverage is never conflated with
 * a missing/stale GPS reading — see the "clarify Risk Zone availability
 * semantics" investigation (2026-08-04). One of four freshness/availability
 * vocabularies in this codebase — see docs/data-freshness.md.
 *
 *   matched                 — fresh real GPS, inside a curated zone's radius.
 *   outside_monitored_zones — fresh real GPS, but no curated zone contains
 *                              it. This is a REAL, available reading (a
 *                              confirmed "no known elevated zone risk here"
 *                              against SafeHaul's v1 curated dataset — not
 *                              nationwide coverage), not a data gap. Backs a
 *                              genuine `zoneRisk` value of 0, never a
 *                              fabricated penalty.
 *   location_unavailable    — no usable GPS at all; no lookup could run.
 *   location_stale          — GPS exists but is too old to trust for "where
 *                              is the truck right now"; no lookup could run.
 *
 * Only `matched` and `outside_monitored_zones` represent an available
 * zoneRisk value; `location_unavailable`/`location_stale` are genuine gaps.
 */
export type ZoneAvailability =
  | "matched"
  | "outside_monitored_zones"
  | "location_unavailable"
  | "location_stale";

/** Canonical, UI-safe wording for each ZoneAvailability — single source of truth so backend and frontend never drift. */
export const ZONE_AVAILABILITY_EXPLANATIONS: Record<ZoneAvailability, string> = {
  matched:                  "Inside a monitored risk zone",
  outside_monitored_zones:  "Outside monitored risk zones",
  location_unavailable:     "Location unavailable",
  location_stale:           "Location data stale",
};

/**
 * Transparency-only breakdown of a driver's current Zone Risk (Phase 3 —
 * Real Zone Risk) — same relationship to DriverContext.zoneRisk that
 * WeatherDetail has to DriverContext.weather, and gated on location the
 * same way (only a fresh real GPS reading may drive a lookup for a pilot;
 * stale/unavailable location never falls back to a mock zone).
 *
 * Unlike weather, the underlying lookup (lib/providers/zones/zoneRisk.ts)
 * is a pure in-process nearest-match against a bundled static dataset, not
 * a live network call — `observedAt` is therefore always the moment the
 * lookup ran (there's no separate upstream "observation time" to preserve,
 * unlike OpenWeatherMap's `dt`).
 *
 * `status` is a coarse available/unavailable summary derived from
 * `availability` (available = matched | outside_monitored_zones; unavailable
 * = location_unavailable | location_stale) — kept for existing consumers.
 * `availability`/`explanation` carry the actual 4-way distinction; prefer
 * them for anything user-facing.
 *
 * `matchedZoneId`/`distanceMiles` exist purely for auditability: they
 * answer "why did this zone match" without needing to cross-reference the
 * dataset file separately.
 */
export interface ZoneDetail {
  zoneRisk: number | null;
  zoneName: string | null;
  /** The matched zone's own hazard category (ZoneType from lib/providers/zones/zoneData.ts) — null unless availability is "matched". */
  zoneType: string | null;
  /** The matched zone's own driver-facing explanation (ZoneDefinition.explanation) — null unless availability is "matched". Distinct from `explanation` below, which describes *availability*, not the hazard itself. */
  zoneExplanation: string | null;
  availability: ZoneAvailability;
  /** Ready-to-display wording matching `availability` — see ZONE_AVAILABILITY_EXPLANATIONS. */
  explanation: string;
  status: "available" | "unavailable";
  origin: "observed" | "simulated" | null;
  provider: "internal_geofence" | null;
  observedAt: string | null;
  fetchedAt: string;
  latitude: number | null;
  longitude: number | null;
  locationState: LocationState | null;
  locationObservedAt: string | null;
  matchedZoneId: string | null;
  distanceMiles: number | null;
}

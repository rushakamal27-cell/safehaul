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
export type FieldState = "fresh" | "cached" | "fallback" | "unavailable";
export type ProviderId = "samsara" | "openweather" | "internal" | null;

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

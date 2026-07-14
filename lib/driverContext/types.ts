/**
 * lib/driverContext/types.ts
 *
 * Provider-neutral normalized representation of a driver's current
 * operational context. Each field separates its value from four pieces of
 * metadata: where it came from (origin), how fresh/available it is (state),
 * which provider supplied it, and when it was observed.
 *
 * Scope: this first version covers only the five fields the risk engine
 * already consumes (safetyEvents, hos, speed, weather, zoneRisk). Location
 * and vehicle context are deferred until they have real consumers.
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

export interface DriverContext {
  driverId: string;
  safetyEvents: DriverContextField<DriverContextSafetyEvent[]>;
  hos: DriverContextField<number>;
  speed: DriverContextField<number>;
  weather: DriverContextField<number>;
  zoneRisk: DriverContextField<number>;
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
}

/**
 * Backend-derived summary of how truthful/complete the current score inputs
 * are — independent of `dataSource`, which only says whether the driver is
 * on a real pilot provider path. See lib/driverContext/contextStatus.ts for
 * the derivation rules.
 */
export type ContextStatus = "full_live" | "partial_live" | "demo";

/**
 * lib/driverContext/assemble.ts
 *
 * Composition root for DriverContext (see ./types.ts for the model).
 * Wraps the existing provider-layer fetchers — lib/samsara.ts (mock, with
 * real swap-in points) and lib/driverEvents.ts + onDemandSync (real
 * DriverEvent rows for pilot drivers) — with per-field provenance metadata.
 * Provider fetchers themselves are unchanged; this module only decides,
 * per field, which source answered and how to label it.
 *
 * Field rules:
 *   - safetyEvents: real DriverEvent rows for pilot drivers, simulated
 *     scenario events otherwise. State reflects the on-demand sync outcome
 *     ("refreshed" → fresh, anything else → cached — stored events stay
 *     real even when a refresh attempt didn't run or failed this call).
 *   - hos: real Samsara HOS clocks for pilot drivers with a resolvable
 *     mapping (see assembleHos below) — unlike speed/zoneRisk, a failed or
 *     unresolvable pilot fetch yields value: null, state: "unavailable",
 *     NOT a mock fallback number, per explicit product requirement ("do not
 *     silently substitute a fake value"). Demo drivers still get a
 *     simulated value.
 *   - speed / zoneRisk: no real source is integrated for any driver yet.
 *     Pilot drivers get state "fallback" (a real source is expected
 *     eventually); demo drivers get state "fresh" (intentional demo mode,
 *     not a gap).
 *   - weather (Phase 2 — Weather from Real Vehicle GPS): for pilots, gated
 *     strictly on location.state === "fresh" — only a fresh real GPS
 *     reading may back a weather request; stale/unavailable location
 *     yields weather value: null, state: "unavailable", NEVER the old
 *     wrong-location mock fallback (see assembleWeather below). Demo
 *     drivers are unchanged: real when OPENWEATHER_API_KEY is set and the
 *     call succeeds for the scenario's coordinates, simulated fallback
 *     otherwise.
 *   - location (Phase 1 — Real GPS): real Samsara GPS for pilot drivers via
 *     the current vehicle stats snapshot (see assembleLocation below) —
 *     like hos, a failed/unresolvable/too-old pilot fetch yields value:
 *     null, state: "unavailable", never a mock coordinate. Demo drivers
 *     keep the existing mock scenario coordinates. Does not yet back a
 *     RiskInput field or affect contextStatus — see assembleLocation's and
 *     DriverContext.location's own comments.
 */

import { getScenarioForDriver } from "@/lib/mockScenarios";
import {
  getMockDriverHos,
  getMockVehicleStats,
  getMockSafetyEvents,
  getMockZoneRisk,
  getWeatherRiskField,
  type RealWeatherResult,
} from "@/lib/samsara";
import {
  getRecentDriverEvents,
  driverEventsToRiskSafetyEvents,
} from "@/lib/driverEvents";
import { ensureFreshSamsaraSync, type OnDemandSyncStatus } from "@/lib/providers/samsara/onDemandSync";
import { fetchSamsaraHosClocks, parseHosClockEntry } from "@/lib/providers/samsara/hos";
import { resolveCurrentVehicleId, type ResolvedVehicleId } from "@/lib/providers/samsara/vehicleId";
import {
  fetchVehicleGpsSnapshot,
  normalizeVehicleGpsSnapshot,
  type SamsaraVehicleStatsSnapshotResponse,
} from "@/lib/providers/samsara/vehicleStats";
import { prisma } from "@/lib/prisma";
import type {
  DriverContext,
  DriverContextField,
  FieldState,
  HosDetail,
  LocationState,
  VehicleLocation,
  WeatherDetail,
} from "./types";

const HOS_FETCH_TIMEOUT_MS = 5_000;
const LOCATION_FETCH_TIMEOUT_MS = 5_000;
const WEATHER_FETCH_TIMEOUT_MS = 5_000;

/** GPS reports every ~5-6s while a vehicle is online (verified live, 2026-07-22) — a reading past this age means the truck is very likely off/offline, not just "not yet polled." */
export const LOCATION_FRESH_THRESHOLD_MS = 10 * 60 * 1000;
/** Beyond this, a position is no longer a meaningful proxy for "current" anything — treated the same as no reading at all. */
export const LOCATION_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Pure — classifies a location reading's age into the three-state
 * LocationState vocabulary. A missing or unparseable timestamp is
 * unavailable, never a crash. A reading that appears to be from the future
 * (small clock skew between Samsara and this server) yields a negative age,
 * which naturally falls into "fresh" via the same `<=` comparison — no
 * special-casing needed, and it can't silently classify as anything worse
 * than fresh, so a skewed clock never fabricates a stale/unavailable state.
 */
export function classifyLocationFreshness(observedAtIso: string | null | undefined, now: Date): LocationState {
  if (!observedAtIso) return "unavailable";
  const observedMs = new Date(observedAtIso).getTime();
  if (!isFinite(observedMs)) return "unavailable";

  const ageMs = now.getTime() - observedMs;
  if (ageMs <= LOCATION_FRESH_THRESHOLD_MS) return "fresh";
  if (ageMs <= LOCATION_STALE_THRESHOLD_MS) return "stale";
  return "unavailable";
}

export interface DriverContextLiveData {
  provider: string;
  lastEventType: string | null;
  lastEventTimestamp: string | null;
  lastSyncTime: string | null;
  driverEventCount24h: number;
  syncStatus: OnDemandSyncStatus;
}

export interface AssembleDriverContextResult {
  context: DriverContext;
  /** null for non-pilot drivers — no sync is attempted for them. */
  liveData: DriverContextLiveData | null;
  hosDetail: HosDetail;
  locationDetail: VehicleLocation;
  weatherDetail: WeatherDetail;
}

/** Pure — labels a not-yet-integrated field: "fallback" for pilots (real source expected eventually), "fresh" for demo (intentional). */
export function simulatedField<T>(value: T, isPilot: boolean, now: string): DriverContextField<T> {
  return isPilot
    ? { value, origin: "simulated", state: "fallback", provider: null, observedAt: null }
    : { value, origin: "simulated", state: "fresh", provider: "internal", observedAt: now };
}

/** Pure — maps an on-demand sync outcome to safetyEvents freshness. Stored events stay "observed" either way; only their just-confirmed-ness changes. */
export function fieldStateForSyncStatus(status: OnDemandSyncStatus): FieldState {
  return status === "refreshed" ? "fresh" : "cached";
}

async function assembleSafetyEvents(
  driverId: string,
  isPilot: boolean,
  now: string
): Promise<{ field: DriverContext["safetyEvents"]; liveData: DriverContextLiveData | null }> {
  if (!isPilot) {
    const scenario = getScenarioForDriver(driverId);
    return {
      field: {
        value: getMockSafetyEvents(scenario).map(({ type, severity }) => ({ type, severity })),
        origin: "simulated",
        state: "fresh",
        provider: "internal",
        observedAt: now,
      },
      liveData: null,
    };
  }

  // Refresh Samsara data on-demand if it's stale — replaces the removed
  // 5-minute cron (Hobby plan). No-ops (status "fresh") on the common path.
  const syncDecision = await ensureFreshSamsaraSync();

  console.info(
    JSON.stringify({
      msg: "on_demand_sync_decision",
      driverId,
      previousLastSyncAt: syncDecision.previousLastSyncAt?.toISOString() ?? null,
      status: syncDecision.status,
      elapsedMs: syncDecision.elapsedMs,
    })
  );

  // Re-read events after the (possible) sync so scoring reflects any newly stored data.
  const [realEvents, mapping, syncState] = await Promise.all([
    getRecentDriverEvents(driverId),
    prisma.driverProviderMapping.findFirst({
      where: { driverId, isPilot: true, isActive: true },
      select: { provider: true },
    }),
    prisma.providerSyncState.findFirst({
      where: { provider: "samsara", streamKey: "safety-events" },
      select: { lastSyncAt: true },
    }),
  ]);

  const observedAt =
    realEvents[0]?.timestamp.toISOString() ?? syncState?.lastSyncAt?.toISOString() ?? now;

  return {
    field: {
      value: driverEventsToRiskSafetyEvents(realEvents),
      origin: "observed",
      state: fieldStateForSyncStatus(syncDecision.status),
      provider: "samsara",
      observedAt,
    },
    liveData: {
      provider: mapping?.provider ?? "samsara",
      lastEventType: realEvents[0]?.type ?? null,
      lastEventTimestamp: realEvents[0]?.timestamp.toISOString() ?? null,
      lastSyncTime: syncState?.lastSyncAt?.toISOString() ?? null,
      driverEventCount24h: realEvents.length,
      syncStatus: syncDecision.status,
    },
  };
}

/**
 * Resolves real Samsara HOS for a pilot driver. Unlike simulatedField's
 * pilot branch (a labeled placeholder for fields with no real source at
 * all), a failed or unresolvable fetch here returns value: null,
 * state: "unavailable" — HOS IS integrated for pilots now, so a failure
 * must not be disguised as a mock number. shiftHoursUsed feeds the risk
 * engine (DriverContext.hos.value); the rest of the breakdown is
 * transparency-only (see HosDetail in ./types.ts).
 */
async function assembleHos(
  driverId: string,
  isPilot: boolean,
  now: string
): Promise<{ field: DriverContext["hos"]; detail: HosDetail }> {
  if (!isPilot) {
    const hoursUsed = getMockDriverHos(getScenarioForDriver(driverId)).hosHoursUsed;
    return {
      field: simulatedField(hoursUsed, false, now),
      detail: {
        drivingHoursUsed: null,
        drivingHoursRemaining: null,
        shiftHoursUsed: hoursUsed,
        status: "available",
        source: "mock",
        updatedAt: now,
      },
    };
  }

  const unavailable = (): { field: DriverContext["hos"]; detail: HosDetail } => ({
    field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null },
    detail: {
      drivingHoursUsed: null,
      drivingHoursRemaining: null,
      shiftHoursUsed: null,
      status: "unavailable",
      source: "none",
      updatedAt: null,
    },
  });

  const mapping = await prisma.driverProviderMapping.findFirst({
    where: { driverId, isPilot: true, isActive: true },
    select: { externalDriverId: true },
  });
  if (!mapping) return unavailable();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HOS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchSamsaraHosClocks({
      driverIds: [mapping.externalDriverId],
      signal: controller.signal,
    });
    const entry =
      response.data?.find((d) => d.driver?.id === mapping.externalDriverId) ?? response.data?.[0];
    const parsed = parseHosClockEntry(entry, new Date());

    if (parsed.shiftHoursUsed === null) return unavailable();

    return {
      field: {
        value: parsed.shiftHoursUsed,
        origin: "observed",
        state: parsed.status === "stale" ? "cached" : "fresh",
        provider: "samsara",
        observedAt: parsed.updatedAt ?? now,
      },
      detail: {
        drivingHoursUsed: null,
        drivingHoursRemaining: parsed.drivingHoursRemaining,
        shiftHoursUsed: parsed.shiftHoursUsed,
        status: parsed.status,
        source: "samsara",
        updatedAt: parsed.updatedAt,
      },
    };
  } catch (err) {
    console.error("[driverContext] Samsara HOS fetch failed:", err instanceof Error ? err.message : err);
    return unavailable();
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Injectable seam for assembleLocation, mirroring RunSyncDeps in syncSafetyEvents.ts — lets tests exercise fresh/stale/unavailable without a live Samsara call or a real DB. */
export interface AssembleLocationDeps {
  resolveVehicleId?: (driverId: string) => Promise<ResolvedVehicleId>;
  fetchGpsSnapshot?: (params: { vehicleId: string; signal?: AbortSignal }) => Promise<SamsaraVehicleStatsSnapshotResponse>;
}

/**
 * Resolves a pilot driver's real current vehicle location via Samsara GPS
 * (Phase 1 — Real GPS). Structured identically to assembleHos's real-or-
 * unavailable design: a failed/unresolvable/stale-beyond-threshold fetch
 * never falls back to mock coordinates for a pilot — only `unavailable()`.
 * `stale` still carries the real coordinates (for transparency), classified
 * via classifyLocationFreshness. Non-pilots keep the existing mock scenario
 * coordinates (getMockVehicleStats), same as speed/zoneRisk, with simulated
 * provenance surfaced through ContextSources — never getMockDriverLocation,
 * which duplicates the same mock source under a different name.
 *
 * Location does not yet feed RiskInput (see toRiskInput.ts) and is
 * deliberately excluded from deriveContextStatus's field list — see
 * contextStatus.ts. Presence/absence of location cannot change the risk
 * score in this phase.
 */
export async function assembleLocation(
  driverId: string,
  isPilot: boolean,
  now: string,
  deps: AssembleLocationDeps = {}
): Promise<{ field: DriverContext["location"]; detail: VehicleLocation }> {
  const fetchedAt = now;

  if (!isPilot) {
    const scenario = getScenarioForDriver(driverId);
    const vehicle = getMockVehicleStats(scenario);
    return {
      field: simulatedField({ latitude: vehicle.lat, longitude: vehicle.lng }, false, now),
      detail: {
        latitude: vehicle.lat,
        longitude: vehicle.lng,
        observedAt: now,
        fetchedAt,
        provider: null,
        providerVehicleId: null,
        vehicleIdSource: "unavailable",
        state: "fresh",
        source: "none",
        vehicleName: null,
        headingDegrees: null,
        speedMilesPerHour: vehicle.currentSpeed,
        isEcuSpeed: null,
        formattedLocation: scenario.locationLabel,
      },
    };
  }

  const unavailable = (
    vehicleIdSource: VehicleLocation["vehicleIdSource"],
    providerVehicleId: string | null = null
  ): { field: DriverContext["location"]; detail: VehicleLocation } => ({
    field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null },
    detail: {
      latitude: null,
      longitude: null,
      observedAt: null,
      fetchedAt,
      provider: null,
      providerVehicleId,
      vehicleIdSource,
      state: "unavailable",
      source: "none",
      vehicleName: null,
      headingDegrees: null,
      speedMilesPerHour: null,
      isEcuSpeed: null,
      formattedLocation: null,
    },
  });

  const resolveVehicleId = deps.resolveVehicleId ?? resolveCurrentVehicleId;
  const fetchGpsSnapshot = deps.fetchGpsSnapshot ?? fetchVehicleGpsSnapshot;

  const { vehicleId, source: vehicleIdSource } = await resolveVehicleId(driverId);
  if (!vehicleId) return unavailable("unavailable");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCATION_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchGpsSnapshot({ vehicleId, signal: controller.signal });
    const reading = normalizeVehicleGpsSnapshot(response, vehicleId);
    if (!reading) return unavailable(vehicleIdSource, vehicleId);

    const state = classifyLocationFreshness(reading.observedAt, new Date(now));
    if (state === "unavailable") return unavailable(vehicleIdSource, vehicleId);

    return {
      field: {
        value: { latitude: reading.latitude, longitude: reading.longitude },
        origin: "observed",
        state: state === "stale" ? "cached" : "fresh",
        provider: "samsara",
        observedAt: reading.observedAt,
      },
      detail: {
        latitude: reading.latitude,
        longitude: reading.longitude,
        observedAt: reading.observedAt,
        fetchedAt,
        provider: "samsara",
        providerVehicleId: vehicleId,
        vehicleIdSource,
        state,
        source: "vehicle_stats",
        vehicleName: reading.vehicleName,
        headingDegrees: reading.headingDegrees,
        speedMilesPerHour: reading.speedMilesPerHour,
        isEcuSpeed: reading.isEcuSpeed,
        formattedLocation: reading.formattedLocation,
      },
    };
  } catch (err) {
    console.error("[driverContext] Samsara GPS fetch failed:", err instanceof Error ? err.message : err);
    return unavailable(vehicleIdSource, vehicleId);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Injectable seam for assembleWeather, same pattern as AssembleLocationDeps. */
export interface AssembleWeatherDeps {
  fetchWeather?: (params: { latitude: number; longitude: number; signal?: AbortSignal }) => Promise<RealWeatherResult | null>;
}

/**
 * Resolves weather using the already-assembled location (Phase 2 — Weather
 * from Real Vehicle GPS). Takes locationDetail as a parameter rather than
 * calling assembleLocation itself — assembleLocation must run exactly once
 * per DriverContext request (see assembleDriverContext), and this function
 * must never call the Samsara GPS endpoint independently.
 *
 * Pilot: only locationDetail.state === "fresh" may drive a weather request.
 * "stale" location keeps its coordinates visible in DriverContext.location
 * for transparency, but a truck's position from 10+ minutes ago is not a
 * safe stand-in for "where it is now" for weather purposes — so stale and
 * unavailable are treated identically here: weather becomes unavailable,
 * no OpenWeatherMap call is made, and no scenario/mock coordinate is ever
 * substituted. A fresh-GPS request that itself fails also yields
 * unavailable, never simulated, for a pilot — see the "trust rule never
 * applies simulated to a pilot" pattern also used by assembleHos/assembleLocation.
 *
 * Demo: unchanged from before this phase — scenario coordinates, real
 * OpenWeatherMap value when available, simulated scenario.weatherRisk
 * fallback otherwise.
 */
export async function assembleWeather(
  driverId: string,
  isPilot: boolean,
  now: string,
  locationDetail: VehicleLocation,
  deps: AssembleWeatherDeps = {}
): Promise<{ field: DriverContext["weather"]; detail: WeatherDetail }> {
  const fetchWeather = deps.fetchWeather ?? getWeatherRiskField;
  const fetchedAt = now;

  const unavailable = (
    latitude: number | null,
    longitude: number | null,
    locationState: LocationState | null,
    locationObservedAt: string | null
  ): { field: DriverContext["weather"]; detail: WeatherDetail } => ({
    field: { value: null, origin: null, state: "unavailable", provider: null, observedAt: null },
    detail: {
      weatherRisk: null,
      status: "unavailable",
      origin: null,
      provider: null,
      observedAt: null,
      fetchedAt,
      latitude,
      longitude,
      locationState,
      locationObservedAt,
      conditionSummary: null,
    },
  });

  const fetchWithTimeout = async (latitude: number, longitude: number): Promise<RealWeatherResult | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEATHER_FETCH_TIMEOUT_MS);
    try {
      return await fetchWeather({ latitude, longitude, signal: controller.signal });
    } catch (err) {
      console.error("[driverContext] Weather fetch failed:", err instanceof Error ? err.message : err);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  if (!isPilot) {
    const scenario = getScenarioForDriver(driverId);
    const result = await fetchWithTimeout(scenario.lat, scenario.lng);

    if (result) {
      return {
        field: { value: result.weatherRisk, origin: "observed", state: "fresh", provider: "openweather", observedAt: result.observedAt },
        detail: {
          weatherRisk: result.weatherRisk,
          status: "available",
          origin: "observed",
          provider: "openweather",
          observedAt: result.observedAt,
          fetchedAt,
          latitude: scenario.lat,
          longitude: scenario.lng,
          locationState: null,
          locationObservedAt: null,
          conditionSummary: result.conditionSummary,
        },
      };
    }

    return {
      field: { value: scenario.weatherRisk, origin: "simulated", state: "fallback", provider: null, observedAt: null },
      detail: {
        weatherRisk: scenario.weatherRisk,
        status: "available",
        origin: "simulated",
        provider: null,
        observedAt: null,
        fetchedAt,
        latitude: scenario.lat,
        longitude: scenario.lng,
        locationState: null,
        locationObservedAt: null,
        conditionSummary: null,
      },
    };
  }

  // Pilot: only a fresh real GPS location may drive a weather request.
  if (locationDetail.state !== "fresh" || locationDetail.latitude === null || locationDetail.longitude === null) {
    return unavailable(null, null, locationDetail.state, locationDetail.observedAt);
  }

  const result = await fetchWithTimeout(locationDetail.latitude, locationDetail.longitude);
  if (!result) {
    return unavailable(locationDetail.latitude, locationDetail.longitude, locationDetail.state, locationDetail.observedAt);
  }

  return {
    field: { value: result.weatherRisk, origin: "observed", state: "fresh", provider: "openweather", observedAt: result.observedAt },
    detail: {
      weatherRisk: result.weatherRisk,
      status: "available",
      origin: "observed",
      provider: "openweather",
      observedAt: result.observedAt,
      fetchedAt,
      latitude: locationDetail.latitude,
      longitude: locationDetail.longitude,
      locationState: locationDetail.state,
      locationObservedAt: locationDetail.observedAt,
      conditionSummary: result.conditionSummary,
    },
  };
}

export async function assembleDriverContext(
  driverId: string,
  isPilot: boolean
): Promise<AssembleDriverContextResult> {
  const now = new Date().toISOString();
  const scenario = getScenarioForDriver(driverId);

  const [safetyEventsResult, hosResult, locationResult] = await Promise.all([
    assembleSafetyEvents(driverId, isPilot, now),
    assembleHos(driverId, isPilot, now),
    assembleLocation(driverId, isPilot, now),
  ]);

  // Weather depends on location's result (Phase 2) — run after the above
  // resolve, never independently re-fetching GPS.
  const weatherResult = await assembleWeather(driverId, isPilot, now, locationResult.detail);

  const speed = simulatedField(getMockVehicleStats(scenario).currentSpeed, isPilot, now);
  const zoneRisk = simulatedField(getMockZoneRisk(scenario), isPilot, now);

  return {
    context: {
      driverId,
      safetyEvents: safetyEventsResult.field,
      hos: hosResult.field,
      speed,
      weather: weatherResult.field,
      zoneRisk,
      location: locationResult.field,
    },
    liveData: safetyEventsResult.liveData,
    hosDetail: hosResult.detail,
    locationDetail: locationResult.detail,
    weatherDetail: weatherResult.detail,
  };
}

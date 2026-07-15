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
 *   - weather: independent of pilot status — real when OPENWEATHER_API_KEY
 *     is set and the call succeeds, simulated fallback otherwise.
 */

import { getScenarioForDriver } from "@/lib/mockScenarios";
import {
  getMockDriverHos,
  getMockVehicleStats,
  getMockSafetyEvents,
  getMockZoneRisk,
  getWeatherRiskField,
} from "@/lib/samsara";
import {
  getRecentDriverEvents,
  driverEventsToRiskSafetyEvents,
} from "@/lib/driverEvents";
import { ensureFreshSamsaraSync, type OnDemandSyncStatus } from "@/lib/providers/samsara/onDemandSync";
import { fetchSamsaraHosClocks, parseHosClockEntry } from "@/lib/providers/samsara/hos";
import { prisma } from "@/lib/prisma";
import type { DriverContext, DriverContextField, FieldState, HosDetail } from "./types";

const HOS_FETCH_TIMEOUT_MS = 5_000;

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

export async function assembleDriverContext(
  driverId: string,
  isPilot: boolean
): Promise<AssembleDriverContextResult> {
  const now = new Date().toISOString();
  const scenario = getScenarioForDriver(driverId);

  const [safetyEventsResult, weatherResult, hosResult] = await Promise.all([
    assembleSafetyEvents(driverId, isPilot, now),
    getWeatherRiskField(scenario),
    assembleHos(driverId, isPilot, now),
  ]);

  const speed = simulatedField(getMockVehicleStats(scenario).currentSpeed, isPilot, now);
  const zoneRisk = simulatedField(getMockZoneRisk(scenario), isPilot, now);

  const weather: DriverContextField<number> = weatherResult.real
    ? { value: weatherResult.value, origin: "observed", state: "fresh", provider: "openweather", observedAt: now }
    : { value: weatherResult.value, origin: "simulated", state: "fallback", provider: null, observedAt: null };

  return {
    context: {
      driverId,
      safetyEvents: safetyEventsResult.field,
      hos: hosResult.field,
      speed,
      weather,
      zoneRisk,
    },
    liveData: safetyEventsResult.liveData,
    hosDetail: hosResult.detail,
  };
}

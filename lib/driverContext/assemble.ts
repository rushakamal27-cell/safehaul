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
 *   - hos / speed / zoneRisk: no real source is integrated for any driver
 *     yet. Pilot drivers get state "fallback" (a real source is expected
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
  isPilotDriver,
  getRecentDriverEvents,
  driverEventsToRiskSafetyEvents,
} from "@/lib/driverEvents";
import { ensureFreshSamsaraSync, type OnDemandSyncStatus } from "@/lib/providers/samsara/onDemandSync";
import { prisma } from "@/lib/prisma";
import type { DriverContext, DriverContextField, FieldState } from "./types";

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
  isPilot: boolean;
  /** null for non-pilot drivers — no sync is attempted for them. */
  liveData: DriverContextLiveData | null;
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

export async function assembleDriverContext(driverId: string): Promise<AssembleDriverContextResult> {
  const now = new Date().toISOString();
  const isPilot = await isPilotDriver(driverId);
  const scenario = getScenarioForDriver(driverId);

  const [safetyEventsResult, weatherResult] = await Promise.all([
    assembleSafetyEvents(driverId, isPilot, now),
    getWeatherRiskField(scenario),
  ]);

  const hos = simulatedField(getMockDriverHos(scenario).hosHoursUsed, isPilot, now);
  const speed = simulatedField(getMockVehicleStats(scenario).currentSpeed, isPilot, now);
  const zoneRisk = simulatedField(getMockZoneRisk(scenario), isPilot, now);

  const weather: DriverContextField<number> = weatherResult.real
    ? { value: weatherResult.value, origin: "observed", state: "fresh", provider: "openweather", observedAt: now }
    : { value: weatherResult.value, origin: "simulated", state: "fallback", provider: null, observedAt: null };

  return {
    context: {
      driverId,
      safetyEvents: safetyEventsResult.field,
      hos,
      speed,
      weather,
      zoneRisk,
    },
    isPilot,
    liveData: safetyEventsResult.liveData,
  };
}

/**
 * lib/driverContext/captureObservation.ts
 *
 * Phase 6B.2 — DriverObservation collector. Builds and persists one
 * DriverObservation row from the SAME trusted context-assembly stack
 * assembleDriverContext() already uses for /api/risk (assembleLocation,
 * assembleWeather, assembleZoneRisk, assembleHos, assembleSpeed) — no
 * duplicate provider clients, no parallel fetching logic, no new provenance
 * vocabulary. See prisma/schema.prisma's DriverObservation model comment for
 * the three-timestamp/contextJson design this implements.
 *
 * Phase 6B.2 scope ONLY: this module exposes a reusable function, nothing
 * calls it automatically. No scheduler, no Safety Event hook, no cron exist
 * yet — see scripts/captureDriverObservation.ts for the manual entry point.
 */

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma";
import { isPilotDriver } from "@/lib/driverEvents";
import {
  assembleLocation,
  assembleWeather,
  assembleZoneRisk,
  assembleHos,
  assembleSpeed,
} from "./assemble";
import type { DriverContextField, HosDetail, VehicleLocation, WeatherDetail, ZoneDetail } from "./types";

export type DriverObservationTriggerType = "interval" | "safety_event";

export interface CaptureDriverObservationParams {
  driverId: string;
  triggerType: DriverObservationTriggerType;
  /** Only valid alongside triggerType "safety_event" — see validateParams. */
  driverEventId?: string;
}

/**
 * Full context snapshot persisted as DriverObservation.contextJson. Reuses
 * the existing transparency detail types verbatim (lib/driverContext/types.ts)
 * rather than inventing a new provenance shape — each already carries
 * origin/state/provider/observedAt/fetchedAt (or the closest equivalent).
 * `speed` has no dedicated Detail type in this codebase (see assemble.ts's
 * assembleSpeed comment — VehicleLocation already carries the same reading),
 * so its own DriverContextField is stored directly instead.
 */
export interface DriverObservationContext {
  location: VehicleLocation;
  weather: WeatherDetail;
  hos: HosDetail;
  zone: ZoneDetail;
  speed: DriverContextField<number>;
}

export interface DriverObservationSnapshot {
  driverId: string;
  triggerType: DriverObservationTriggerType;
  driverEventId: string | null;
  observedAt: string;
  collectedAt: string;
  latitude: number | null;
  longitude: number | null;
  speedMph: number | null;
  hosShiftHoursUsed: number | null;
  weatherRisk: number | null;
  zoneRisk: number | null;
  contextJson: DriverObservationContext;
}

export interface CapturedDriverObservation extends DriverObservationSnapshot {
  id: string;
}

/** Narrow slice of Prisma this module needs — injectable for tests, same pattern as RunSyncDeps/OnDemandSyncDeps elsewhere in lib/providers/samsara. */
export interface CaptureDriverObservationDeps {
  driverClient?: {
    findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
  driverEventClient?: {
    findUnique(args: {
      where: { id: string };
      select: { driverId: true };
    }): Promise<{ driverId: string } | null>;
  };
  observationClient?: {
    create(args: { data: Prisma.DriverObservationUncheckedCreateInput }): Promise<{ id: string }>;
  };
  isPilotDriver?: (driverId: string) => Promise<boolean>;
  assembleLocationFn?: typeof assembleLocation;
  assembleWeatherFn?: typeof assembleWeather;
  assembleZoneRiskFn?: typeof assembleZoneRisk;
  assembleHosFn?: typeof assembleHos;
  assembleSpeedFn?: typeof assembleSpeed;
}

/**
 * Validates the collector contract:
 *   - the driver must exist
 *   - "interval" observations must NOT carry a driverEventId (they aren't
 *     tied to any single event)
 *   - "safety_event" observations MAY carry a driverEventId; when supplied,
 *     it must reference a real DriverEvent belonging to the SAME driver
 * Throws a plain Error with a specific message on any violation — matches
 * this codebase's existing convention for collector-style validation
 * (e.g. lib/providers/samsara/vehicleStats.ts's missing-token check) rather
 * than introducing a new custom error class for one module.
 */
async function validateParams(
  params: CaptureDriverObservationParams,
  deps: CaptureDriverObservationDeps
): Promise<void> {
  const driverClient = deps.driverClient ?? prisma.driver;
  const driverEventClient = deps.driverEventClient ?? prisma.driverEvent;

  const driver = await driverClient.findUnique({ where: { id: params.driverId }, select: { id: true } });
  if (!driver) {
    throw new Error(`[captureDriverObservation] No Driver found with id="${params.driverId}"`);
  }

  if (params.triggerType === "interval" && params.driverEventId) {
    throw new Error(
      `[captureDriverObservation] triggerType "interval" must not include a driverEventId (got "${params.driverEventId}") — interval observations are not tied to a specific event.`
    );
  }

  if (params.driverEventId) {
    const event = await driverEventClient.findUnique({
      where: { id: params.driverEventId },
      select: { driverId: true },
    });
    if (!event) {
      throw new Error(`[captureDriverObservation] No DriverEvent found with id="${params.driverEventId}"`);
    }
    if (event.driverId !== params.driverId) {
      throw new Error(
        `[captureDriverObservation] driverEventId="${params.driverEventId}" belongs to driverId="${event.driverId}", not the requested driverId="${params.driverId}"`
      );
    }
  }
}

/**
 * Builds a DriverObservation snapshot without writing anything — the pure
 * (aside from read-only validation lookups and the underlying provider
 * fetches) half of the collector, split out so tests and the manual script's
 * dry-run mode can preview a capture without persisting one.
 *
 * observedAt is ALWAYS the collection instant, never DriverEvent.timestamp —
 * even for a "safety_event"-triggered snapshot, this never claims to
 * describe conditions AT the event; see the DriverObservation model comment
 * in prisma/schema.prisma for the full rationale. The event's own time
 * remains solely on DriverEvent.timestamp, reachable via driverEventId.
 *
 * Resilience: assembleLocation/assembleWeather/assembleZoneRisk/assembleHos
 * already catch their own provider failures internally and degrade to
 * state: "unavailable" rather than throwing (verified in assemble.ts) — this
 * function does not add a second layer of try/catch around them, since
 * doing so would just duplicate protection that already exists. Only the
 * validation lookups above and, in captureDriverObservation, the final
 * prisma write are allowed to fail this call.
 */
export async function buildDriverObservationSnapshot(
  params: CaptureDriverObservationParams,
  deps: CaptureDriverObservationDeps = {}
): Promise<DriverObservationSnapshot> {
  await validateParams(params, deps);

  const isPilotFn = deps.isPilotDriver ?? isPilotDriver;
  const isPilot = await isPilotFn(params.driverId);

  const assembleLocationFn = deps.assembleLocationFn ?? assembleLocation;
  const assembleWeatherFn = deps.assembleWeatherFn ?? assembleWeather;
  const assembleZoneRiskFn = deps.assembleZoneRiskFn ?? assembleZoneRisk;
  const assembleHosFn = deps.assembleHosFn ?? assembleHos;
  const assembleSpeedFn = deps.assembleSpeedFn ?? assembleSpeed;

  // Same instant used as both observedAt and collectedAt — this collector's
  // fetch is synchronous end-to-end, so the two coincide today. Kept as
  // separate DriverObservation columns anyway for a future async/backfill
  // collector (see the schema comment) — that distinction is not introduced
  // here.
  const now = new Date().toISOString();

  // Same dependency order as assembleDriverContext: location first
  // (weather/zone/speed all reuse its GPS reading rather than re-fetching),
  // HOS independent and runs alongside it.
  const [locationResult, hosResult] = await Promise.all([
    assembleLocationFn(params.driverId, isPilot, now),
    assembleHosFn(params.driverId, isPilot, now),
  ]);

  const [weatherResult, zoneRiskResult] = await Promise.all([
    assembleWeatherFn(params.driverId, isPilot, now, locationResult.detail),
    assembleZoneRiskFn(params.driverId, isPilot, now, locationResult.detail),
  ]);

  const speedResult = assembleSpeedFn(params.driverId, isPilot, now, locationResult.detail);

  return {
    driverId: params.driverId,
    triggerType: params.triggerType,
    driverEventId: params.driverEventId ?? null,
    observedAt: now,
    collectedAt: now,
    latitude: locationResult.field.value?.latitude ?? null,
    longitude: locationResult.field.value?.longitude ?? null,
    speedMph: speedResult.field.value ?? null,
    hosShiftHoursUsed: hosResult.field.value ?? null,
    weatherRisk: weatherResult.field.value ?? null,
    zoneRisk: zoneRiskResult.field.value ?? null,
    contextJson: {
      location: locationResult.detail,
      weather: weatherResult.detail,
      hos: hosResult.detail,
      zone: zoneRiskResult.detail,
      speed: speedResult.field,
    },
  };
}

/**
 * Builds a snapshot (buildDriverObservationSnapshot) and persists it as a
 * new DriverObservation row. The only new failure mode versus the snapshot
 * builder is the prisma write itself — matches this phase's requirement
 * that only an invalid driver/event or a database failure should fail the
 * whole observation, never an individual unavailable contextual input.
 */
export async function captureDriverObservation(
  params: CaptureDriverObservationParams,
  deps: CaptureDriverObservationDeps = {}
): Promise<CapturedDriverObservation> {
  const snapshot = await buildDriverObservationSnapshot(params, deps);
  const observationClient = deps.observationClient ?? prisma.driverObservation;

  const created = await observationClient.create({
    data: {
      driverId: snapshot.driverId,
      triggerType: snapshot.triggerType,
      driverEventId: snapshot.driverEventId,
      observedAt: new Date(snapshot.observedAt),
      collectedAt: new Date(snapshot.collectedAt),
      latitude: snapshot.latitude,
      longitude: snapshot.longitude,
      speedMph: snapshot.speedMph,
      hosShiftHoursUsed: snapshot.hosShiftHoursUsed,
      weatherRisk: snapshot.weatherRisk,
      zoneRisk: snapshot.zoneRisk,
      contextJson: snapshot.contextJson as unknown as Prisma.InputJsonValue,
    },
  });

  return { ...snapshot, id: created.id };
}

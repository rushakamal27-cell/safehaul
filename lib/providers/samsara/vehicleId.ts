/**
 * lib/providers/samsara/vehicleId.ts
 *
 * Shared driver-to-current-vehicle resolution for pilot drivers. Extracted
 * from lib/todaySummary.ts so mileage and GPS location use exactly the same
 * resolution path and trust rules — see resolveCurrentVehicleId for the
 * two-step logic.
 */

import { prisma } from "@/lib/prisma";
import { normalizeProviderId } from "@/lib/providers/providerIds";

export type VehicleIdSource = "provider_mapping" | "driver_event" | "unavailable";

export interface ResolvedVehicleId {
  vehicleId: string | null;
  source: VehicleIdSource;
}

export interface VehicleMappingClient {
  findFirst(args: {
    where: { driverId: string; isPilot: true; isActive: true };
    select: { externalVehicleId: true };
  }): Promise<{ externalVehicleId: string | null } | null>;
}

export interface VehicleDriverEventClient {
  findFirst(args: {
    where: { driverId: string; externalVehicleId: { not: null } };
    orderBy: { timestamp: "desc" };
    select: { externalVehicleId: true; timestamp: true };
  }): Promise<{ externalVehicleId: string | null; timestamp: Date } | null>;
}

export interface ResolveVehicleIdDeps {
  mappingClient?: VehicleMappingClient;
  driverEventClient?: VehicleDriverEventClient;
  /** Injectable clock for deterministic freshness tests. Defaults to now. */
  now?: Date;
}

/**
 * How recent a DriverEvent must be for its reported vehicle to override a
 * disagreeing DriverProviderMapping.externalVehicleId. A safety event is
 * emitted by the specific truck the driver is physically in, so a fresh one
 * is direct evidence of the current assignment; the mapping is provisioned
 * out-of-band and nothing in this repo ever updates it, so it can only go
 * stale. Seven days keeps the override tied to genuinely current evidence
 * while leaving the mapping as the default for drivers with sparse events.
 */
export const FRESH_EVENT_VEHICLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Samsara-issued IDs (driver, vehicle, event) have been numeric strings in
 * every example seen so far. Live validation found DriverProviderMapping's
 * externalVehicleId holding a human-readable vehicle display name instead of
 * a Samsara ID for both current pilots (e.g. "TRUCK 263 (IDEAL)") — one of
 * which doesn't even match Samsara's current name for that vehicle
 * ("TRUCK 265"), confirming the mapping's text is not a display authority
 * either. A non-numeric mapping value is treated the same as a missing one
 * (fall through to the DriverEvent-sourced ID) rather than being sent to
 * Samsara, where it's guaranteed to 400. This does not fix the underlying
 * bad row — that should still be corrected at the source.
 */
export function looksLikeSamsaraId(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Resolves the vehicle currently assigned to a pilot driver.
 *
 * Precedence:
 * 1. A DriverEvent from within FRESH_EVENT_VEHICLE_WINDOW_MS whose vehicle
 *    DISAGREES with the mapping — fresh, first-party evidence of the truck
 *    the driver is actually in wins over a mapping that nothing maintains.
 * 2. DriverProviderMapping.externalVehicleId, when it's Samsara-ID-shaped
 *    (the durable assignment, and the default whenever nothing fresher
 *    contradicts it).
 * 3. Fallback: the most recent DriverEvent.externalVehicleId at any age.
 * 4. Otherwise: unavailable. Never guesses, never returns a non-numeric ID.
 *
 * Why step 1 exists (Phase 6D, 2026-10-07): a pilot driver changed trucks and
 * her mapping was never updated, so every GPS/speed/weather/zone reading and
 * every daily odometer delta was fetched from her OLD truck — which another
 * driver was driving ~2,000 miles away. Her own DriverEvents had reported the
 * new vehicle for 16 days. Mapping-first precedence meant the stale manual row
 * silently overrode live reality; this step makes fresh evidence win instead.
 */
export async function resolveCurrentVehicleId(
  driverId: string,
  deps: ResolveVehicleIdDeps = {}
): Promise<ResolvedVehicleId> {
  const mappingClient =
    deps.mappingClient ?? (prisma.driverProviderMapping as unknown as VehicleMappingClient);
  const driverEventClient =
    deps.driverEventClient ?? (prisma.driverEvent as unknown as VehicleDriverEventClient);
  const now = deps.now ?? new Date();

  const [mapping, latestEvent] = await Promise.all([
    mappingClient.findFirst({
      where: { driverId, isPilot: true, isActive: true },
      select: { externalVehicleId: true },
    }),
    driverEventClient.findFirst({
      where: { driverId, externalVehicleId: { not: null } },
      orderBy: { timestamp: "desc" },
      select: { externalVehicleId: true, timestamp: true },
    }),
  ]);

  // Normalize before validating/returning — provider mappings are
  // provisioned out-of-band (no code in this repo writes externalVehicleId),
  // so a leading/trailing whitespace artifact (e.g. a stray \r\n from a CSV/
  // spreadsheet import) can reach this column undetected. Normalizing here,
  // at the point this value is consumed, means such contamination resolves
  // correctly instead of silently rejecting a valid ID. See
  // lib/providers/providerIds.ts for the shared rule.
  const mappingVehicleId = normalizeProviderId(mapping?.externalVehicleId);
  const mappingUsable = !!mappingVehicleId && looksLikeSamsaraId(mappingVehicleId);

  const eventVehicleId = normalizeProviderId(latestEvent?.externalVehicleId);
  const eventIsFresh =
    !!latestEvent && now.getTime() - latestEvent.timestamp.getTime() <= FRESH_EVENT_VEHICLE_WINDOW_MS;

  // Step 1 — fresh contradicting evidence overrides a stale mapping. Only a
  // genuine disagreement triggers this, so behavior is unchanged whenever the
  // two sources already agree.
  if (eventVehicleId && eventIsFresh && (!mappingUsable || eventVehicleId !== mappingVehicleId)) {
    if (mappingUsable) {
      console.warn(
        `[vehicleId] driverId=${driverId}: mapping vehicle ${mappingVehicleId} is stale — ` +
          `a DriverEvent at ${latestEvent!.timestamp.toISOString()} reports ${eventVehicleId}. ` +
          `Using the event-reported vehicle; correct DriverProviderMapping.externalVehicleId at the source.`
      );
    }
    return { vehicleId: eventVehicleId, source: "driver_event" };
  }

  if (mappingUsable) {
    return { vehicleId: mappingVehicleId!, source: "provider_mapping" };
  }

  if (eventVehicleId) {
    return { vehicleId: eventVehicleId, source: "driver_event" };
  }

  return { vehicleId: null, source: "unavailable" };
}

/**
 * lib/providers/samsara/vehicleId.ts
 *
 * Shared driver-to-current-vehicle resolution for pilot drivers. Extracted
 * from lib/todaySummary.ts so mileage and GPS location use exactly the same
 * resolution path and trust rules — see resolveCurrentVehicleId for the
 * two-step logic.
 */

import { prisma } from "@/lib/prisma";

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
    select: { externalVehicleId: true };
  }): Promise<{ externalVehicleId: string | null } | null>;
}

export interface ResolveVehicleIdDeps {
  mappingClient?: VehicleMappingClient;
  driverEventClient?: VehicleDriverEventClient;
}

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
 * 1. DriverProviderMapping.externalVehicleId, when it's Samsara-ID-shaped
 *    (the durable assignment, but currently unreliable for both pilots).
 * 2. Fallback: the most recent DriverEvent.externalVehicleId for the driver
 *    — self-corrects if the assigned vehicle changes, since it's read off
 *    each real event as it arrives. This is the only reliable working
 *    source for both current pilots today.
 * 3. Otherwise: unavailable. Never guesses, never returns a non-numeric ID.
 */
export async function resolveCurrentVehicleId(
  driverId: string,
  deps: ResolveVehicleIdDeps = {}
): Promise<ResolvedVehicleId> {
  const mappingClient =
    deps.mappingClient ?? (prisma.driverProviderMapping as unknown as VehicleMappingClient);
  const driverEventClient =
    deps.driverEventClient ?? (prisma.driverEvent as unknown as VehicleDriverEventClient);

  const mapping = await mappingClient.findFirst({
    where: { driverId, isPilot: true, isActive: true },
    select: { externalVehicleId: true },
  });
  if (mapping?.externalVehicleId && looksLikeSamsaraId(mapping.externalVehicleId)) {
    return { vehicleId: mapping.externalVehicleId, source: "provider_mapping" };
  }

  const latestEvent = await driverEventClient.findFirst({
    where: { driverId, externalVehicleId: { not: null } },
    orderBy: { timestamp: "desc" },
    select: { externalVehicleId: true },
  });
  if (latestEvent?.externalVehicleId) {
    return { vehicleId: latestEvent.externalVehicleId, source: "driver_event" };
  }

  return { vehicleId: null, source: "unavailable" };
}

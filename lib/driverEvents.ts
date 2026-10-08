/**
 * lib/driverEvents.ts
 *
 * Utilities for reading real DriverEvent rows and converting them into
 * provider-neutral risk inputs for the SafeHaul risk engine.
 *
 * Used by the hybrid pilot/non-pilot flow in /api/risk:
 *   - Pilot drivers  → query real DriverEvent rows (this file)
 *   - Non-pilot drivers → existing mock scenario system (lib/samsara.ts)
 */

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Pilot detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the driver has at least one active, pilot-flagged
 * DriverProviderMapping. Any mapping qualifies — provider-agnostic.
 */
export async function isPilotDriver(driverId: string): Promise<boolean> {
  const mapping = await prisma.driverProviderMapping.findFirst({
    where: { driverId, isPilot: true, isActive: true },
    select: { id: true },
  });
  return mapping !== null;
}

// ---------------------------------------------------------------------------
// Event retrieval
// ---------------------------------------------------------------------------

/**
 * Fetches recent DriverEvent rows for a pilot driver.
 *
 * @param driverId  — internal SafeHaul driver ID
 * @param hoursBack — look-back window in hours (default 24)
 * @param limit     — max rows to return (default 100; prevents runaway queries)
 */
export async function getRecentDriverEvents(
  driverId: string,
  hoursBack = 24,
  limit     = 100
): Promise<Array<{ type: string; severity: number; timestamp: Date }>> {
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  return prisma.driverEvent.findMany({
    where: {
      driverId,
      timestamp: { gte: since },
    },
    select: {
      type:      true,
      severity:  true,
      timestamp: true,
    },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Conversion → RiskInput shape
// ---------------------------------------------------------------------------

/**
 * Converts raw DriverEvent rows into the `safetyEvents` array consumed
 * by calculateRisk() in lib/riskEngine.ts.
 *
 * The type strings match the keys handled by calcSafetyEventPenalties.
 * Unknown types are passed through; the engine will ignore them if not mapped.
 */
export function driverEventsToRiskSafetyEvents(
  events: Array<{ type: string; severity: number }>
): Array<{ type: string; severity: number }> {
  return events.map((e) => ({ type: e.type, severity: e.severity }));
}

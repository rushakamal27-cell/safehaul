/**
 * lib/providers/samsara/hosObservability.ts
 *
 * TEMPORARY diagnostic logging (added 2026-08-04, HOS observability
 * investigation) — answers "does Samsara's HOS Clocks endpoint ever return
 * an entry for this pilot driver, e.g. during a confirmed on-duty period?"
 * without altering risk scoring, fabricating HOS values, or exposing raw
 * provider payloads anywhere (UI or logs). Only the minimal fields needed
 * to answer that question are recorded — see HosObservationInput.
 *
 * Throttled to at most one row per driver per LOG_THROTTLE_MS: assembleHos
 * runs on every /api/risk call for a pilot driver (HOS is not cached), so
 * logging unconditionally would be noisy for no diagnostic benefit — the
 * question this exists to answer is "does this ever flip to true," which a
 * coarse time-bucketed sample answers just as well as every single call.
 *
 * Reuses the read-then-write throttle shape already established by
 * lib/providers/samsara/onDemandSync.ts's freshness check, at a much
 * smaller scale (no lock — a lost race here just means one extra row in a
 * table nobody else writes to, not a duplicated external side effect).
 *
 * Safe to delete entirely once the underlying provider-side question is
 * answered: remove the recordHosObservation call in assemble.ts, this file,
 * and the HosObservation model in prisma/schema.prisma.
 */

import { prisma } from "@/lib/prisma";

const LOG_THROTTLE_MS = 15 * 60 * 1000; // at most one recorded observation per driver per 15 min

export interface HosObservationInput {
  driverId: string;
  externalDriverId: string;
  clocksReturned: boolean;
  emptyReason: string | null;
  providerStatus: number | null;
  providerUpdatedAt: string | null;
}

/**
 * Records one HOS fetch outcome, throttled per driver. Never throws —
 * observability must not be able to break the HOS resolution path it's
 * attached to (see the catch below, mirroring assembleHos's own
 * never-throw-to-the-caller contract).
 */
export async function recordHosObservation(input: HosObservationInput): Promise<void> {
  try {
    const recent = await prisma.hosObservation.findFirst({
      where: { driverId: input.driverId, requestedAt: { gte: new Date(Date.now() - LOG_THROTTLE_MS) } },
      select: { id: true },
    });
    if (recent) return;

    await prisma.hosObservation.create({
      data: {
        driverId: input.driverId,
        externalDriverId: input.externalDriverId,
        clocksReturned: input.clocksReturned,
        emptyReason: input.emptyReason,
        providerStatus: input.providerStatus,
        providerUpdatedAt: input.providerUpdatedAt ? new Date(input.providerUpdatedAt) : null,
      },
    });

    console.info(
      JSON.stringify({
        msg: "hos_observation_recorded",
        driverId: input.driverId,
        clocksReturned: input.clocksReturned,
        emptyReason: input.emptyReason,
      })
    );
  } catch (err) {
    console.error("[hos-observability] Failed to record observation:", err instanceof Error ? err.message : err);
  }
}

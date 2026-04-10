/**
 * lib/trip.ts
 *
 * Minimal trip session helper for SafeHaul.
 * One Trip row per driver per UTC calendar day — created on first /api/risk call,
 * reused by all subsequent SafetyEvent and Incident writes that day.
 */

import { prisma } from "@/lib/prisma";

/**
 * Returns the id of today's Trip for the given driver, creating one if none exists.
 * "Today" is the current UTC calendar day (midnight → midnight).
 */
export async function getOrCreateTodayTrip(driverId: string): Promise<string> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const existing = await prisma.trip.findFirst({
    where: { driverId, startedAt: { gte: today } },
    select: { id: true },
  });

  if (existing) return existing.id;

  const trip = await prisma.trip.create({
    data: { driverId, startedAt: new Date() },
  });

  return trip.id;
}

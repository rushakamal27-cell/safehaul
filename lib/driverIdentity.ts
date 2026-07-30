/**
 * lib/driverIdentity.ts
 *
 * Phase 4.6 — Driver Identity & Legal Onboarding (identity foundation only).
 *
 * SafeHaul separates three identities that used to be conflated:
 *   - Telegram identity   → authentication only (Driver.name/telegramLastName/telegramUsername)
 *   - SafeHaul identity    → Driver.canonicalName, the operational identity for
 *                            reports/dashboards/analytics
 *   - Provider identity    → DriverProviderMapping.externalDriverId/providerDriverName
 *
 * Driver.canonicalName is derived, not manually set: whenever a provider
 * reports a driver name, syncProviderDriverName() keeps both the mapping's
 * providerDriverName and Driver.canonicalName in lockstep. No manual override
 * exists yet (out of scope for this phase).
 */

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Provider → SafeHaul name synchronization
// ---------------------------------------------------------------------------

/** Minimal mapping-lookup surface needed for the sync — injectable for tests. */
export interface IdentityMappingClient {
  findUnique(args: {
    where: { provider_externalDriverId: { provider: string; externalDriverId: string } };
    select: {
      id: true;
      driverId: true;
      providerDriverName: true;
      driver: { select: { canonicalName: true } };
    };
  }): Promise<{
    id: string;
    driverId: string;
    providerDriverName: string | null;
    driver: { canonicalName: string | null };
  } | null>;
  update(args: { where: { id: string }; data: { providerDriverName: string } }): Promise<unknown>;
}

/** Minimal driver-update surface needed for the sync — injectable for tests. */
export interface IdentityDriverClient {
  update(args: { where: { id: string }; data: { canonicalName: string } }): Promise<unknown>;
}

export interface SyncProviderDriverNameDeps {
  mappingClient?: IdentityMappingClient;
  driverClient?: IdentityDriverClient;
  /** Runs both updates together; defaults to prisma.$transaction. Tests can pass a simple sequential runner. */
  runTransaction?: (ops: Promise<unknown>[]) => Promise<unknown>;
}

/**
 * Idempotently syncs a provider-reported driver name onto the matching
 * DriverProviderMapping and Driver.canonicalName.
 *
 * No-ops (zero writes) when:
 *   - no active mapping exists for (provider, externalDriverId) — mapping
 *     creation is out of scope for this phase, provisioned out-of-band
 *   - the name is empty/whitespace-only
 *   - the stored providerDriverName and Driver.canonicalName already match
 *     the incoming name (avoids needless writes on every event)
 *
 * Never throws — provider name sync must never break event ingestion.
 * Callers should still wrap this in their own try/catch per their existing
 * per-event error handling, since this issues its own DB calls.
 */
export async function syncProviderDriverName(
  provider: string,
  externalDriverId: string,
  rawName: string | undefined | null,
  deps: SyncProviderDriverNameDeps = {}
): Promise<void> {
  const name = rawName?.trim();
  if (!name) return;

  const mappingClient =
    deps.mappingClient ?? (prisma.driverProviderMapping as unknown as IdentityMappingClient);
  const driverClient = deps.driverClient ?? (prisma.driver as unknown as IdentityDriverClient);
  const runTransaction = deps.runTransaction ?? ((ops: Promise<unknown>[]) => prisma.$transaction(ops as any));

  const mapping = await mappingClient.findUnique({
    where: { provider_externalDriverId: { provider, externalDriverId } },
    select: {
      id: true,
      driverId: true,
      providerDriverName: true,
      driver: { select: { canonicalName: true } },
    },
  });
  if (!mapping) return;

  const mappingUpToDate = mapping.providerDriverName === name;
  const canonicalUpToDate = mapping.driver.canonicalName === name;
  if (mappingUpToDate && canonicalUpToDate) return;

  await runTransaction([
    mappingClient.update({ where: { id: mapping.id }, data: { providerDriverName: name } }),
    driverClient.update({ where: { id: mapping.driverId }, data: { canonicalName: name } }),
  ]);
}

// ---------------------------------------------------------------------------
// Display name resolution
// ---------------------------------------------------------------------------

export interface DisplayNameInput {
  canonicalName?: string | null;
  telegramFirstName?: string | null;
  telegramLastName?: string | null;
  telegramUsername?: string | null;
}

/**
 * Resolves the name to show a driver, in preferred order:
 *   1. canonicalName (real operational identity, e.g. from Samsara)
 *   2. Telegram first + last name
 *   3. Telegram username (prefixed with @) — last resort before a generic label
 *   4. "Driver" — generic fallback
 *
 * Telegram usernames are deliberately last: they're a login handle, not an
 * operational name, and are skipped whenever any real name is available.
 */
export function resolveDisplayName(input: DisplayNameInput): string {
  const canonical = input.canonicalName?.trim();
  if (canonical) return canonical;

  const first = input.telegramFirstName?.trim() ?? "";
  const last = input.telegramLastName?.trim() ?? "";
  const full = [first, last].filter(Boolean).join(" ");
  if (full) return full;

  const username = input.telegramUsername?.trim();
  if (username) return `@${username}`;

  return "Driver";
}

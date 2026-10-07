/**
 * lib/providers/providerIds.ts
 *
 * Single, provider-neutral definition of "normalize an external/provider
 * identifier read out of our own database before using it."
 *
 * Why this exists: no code in this repository writes
 * DriverProviderMapping.externalDriverId or .externalVehicleId — those rows
 * are provisioned out-of-band (manual DB edit / admin tooling / spreadsheet
 * import), so nothing validates them on the way in. A real incident
 * (2026-09-01) found a pilot's externalVehicleId stored as
 * "\r\n281474980432129": a CRLF artifact of exactly the kind a CSV or
 * copy-paste import produces. Because the value failed the all-digits
 * Samsara-ID check, vehicle resolution silently fell through to a weaker
 * source instead of using a perfectly good ID.
 *
 * The same contamination on externalDriverId would be worse, not better:
 * that value is sent to Samsara as a query parameter AND used as the lookup
 * key that attributes an inbound event to a driver, so a stray \r\n means
 * malformed provider requests and silently dropped events.
 *
 * Deliberately conservative — leading/trailing whitespace only (String.trim
 * covers space, tab, CR and LF). It never touches interior characters, never
 * changes case, and never parses the value as a number: Samsara IDs are
 * 15-18 digit strings that would lose precision as JS numbers, so they stay
 * strings end to end.
 */

/**
 * Trims surrounding whitespace/CR/LF from a provider identifier. Returns
 * null for null/undefined input, and null for a value that is empty once
 * trimmed (an all-whitespace cell is absent data, not an identifier).
 */
export function normalizeProviderId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

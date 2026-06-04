/**
 * lib/providers/samsara/normalizeStreamEvent.ts
 *
 * Normalizes a SamsaraSafetyStreamEvent from the v2 Safety Events Stream API
 * into the provider-neutral NormalizedProviderEvent contract.
 *
 * Key differences from the webhook normalizer (normalizeEvent.ts):
 *   - Input shape: flat stream object with behaviorLabels[] array, not a webhook envelope
 *   - Event type: derived from the FIRST behaviorLabels[].label that maps to a DriverEventType
 *   - externalEventId: always event.id (required by Samsara schema; no fallback needed)
 *   - Severity: "low" | "medium" | "high" | "critical" string from Samsara
 *
 * Design rules (same as normalizeEvent.ts):
 *   - NEVER throw — return null on any parse failure
 *   - Log unsupported label strings so new event types are visible without crashing
 *   - All field-path assumptions are marked TODO for validation against real payloads
 */

import {
  SAMSARA_TYPE_MAP,
  normalizeSeverity,
  type DriverEventType,
  type NormalizedProviderEvent,
} from "./normalizeEvent";
import type { SamsaraSafetyStreamEvent } from "./types";

/**
 * Converts a v2 stream safety event into a NormalizedProviderEvent.
 *
 * Returns null when:
 *   - The event has no driver ID
 *   - None of the behaviorLabels map to a supported DriverEventType
 *   - Any unexpected error occurs
 *
 * Never throws.
 */
export function normalizeSafetyStreamEvent(
  event: SamsaraSafetyStreamEvent
): NormalizedProviderEvent | null {
  try {
    // --- Required: external driver ID ---
    // TODO: Confirm field path — observed as event.driver.id in insuretech docs.
    const externalDriverId = event.driver?.id;
    if (!externalDriverId) {
      console.warn(
        `[normalizeStreamEvent] Event id="${event.id}" has no driver.id — skipping`
      );
      return null;
    }

    // --- Event type: first behaviorLabel that maps to a supported DriverEventType ---
    // An event may have multiple labels (e.g., HarshBrake + AggressiveDriving).
    // We take the first supported match. Unknown labels are silently skipped here;
    // only the whole event is logged if NO label matches at all.
    // TODO: Confirm behaviorLabels[].label casing matches SAMSARA_TYPE_MAP keys.
    //       Observed: camelCase ("harshBrake", "mobileUsage") in insuretech examples.
    const labels = event.behaviorLabels ?? [];
    let internalType: DriverEventType | undefined;

    for (const bl of labels) {
      const mapped = SAMSARA_TYPE_MAP[bl.label];
      if (mapped) {
        internalType = mapped;
        break;
      }
    }

    if (!internalType) {
      const labelStrings = labels.map((l) => `"${l.label}"`).join(", ");
      console.info(
        `[normalizeStreamEvent] Event id="${event.id}" has no supported behaviorLabel` +
          (labelStrings ? ` (received: ${labelStrings})` : " (behaviorLabels absent)") +
          " — ignoring"
      );
      return null;
    }

    // --- Optional fields ---
    // Samsara stream uses "asset" (not "vehicle") for the vehicle/asset object.
    const externalVehicleId = event.asset?.id;

    // Severity: Samsara stream uses "low" | "medium" | "high" | "critical".
    // normalizeSeverity handles these string values via SEVERITY_STRING_MAP.
    const severity = normalizeSeverity(event.severity);

    const lat =
      typeof event.location?.latitude === "number"
        ? event.location.latitude
        : undefined;
    const lng =
      typeof event.location?.longitude === "number"
        ? event.location.longitude
        : undefined;

    // Samsara stream event timestamp: "startMs" field (ISO 8601 string despite the name).
    // Falls back to "createdAtTime" if startMs is absent.
    const rawTimestamp = event.startMs ?? event.createdAtTime;
    if (!rawTimestamp) {
      console.warn(
        `[normalizeStreamEvent] Event id="${event.id}" has no startMs or createdAtTime — skipping`
      );
      return null;
    }
    const timestamp = rawTimestamp;

    const normalized: NormalizedProviderEvent = {
      externalDriverId,
      ...(externalVehicleId ? { externalVehicleId } : {}),
      // event.id is required by Samsara schema — always present, always used for dedup
      externalEventId: event.id,
      type: internalType,
      severity,
      timestamp, // ISO 8601 from Samsara startMs
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
    };

    return normalized;
  } catch (err) {
    // Catch-all: normalization must never crash the sync route
    console.error(
      `[normalizeStreamEvent] Unexpected error for event id="${event.id}":`,
      err
    );
    return null;
  }
}

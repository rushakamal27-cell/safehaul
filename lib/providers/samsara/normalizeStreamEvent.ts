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
 *   - NEVER throw — return { event: null, skipReason } on any parse failure
 *   - Skip reasons and observed labels are returned, not logged here — the
 *     caller (route.ts) logs one structured entry per skip
 *   - All field-path assumptions are marked TODO for validation against real payloads
 */

import {
  SAMSARA_TYPE_MAP,
  normalizeSeverity,
  type DriverEventType,
  type NormalizedProviderEvent,
} from "./normalizeEvent";
import type { SamsaraSafetyStreamEvent } from "./types";

/** Why normalizeSafetyStreamEvent() could not produce a NormalizedProviderEvent. */
export type StreamSkipReason =
  | "no_driver_id"
  | "unsupported_behavior_label"
  | "no_timestamp"
  | "unexpected_error";

export interface NormalizeStreamResult {
  event: NormalizedProviderEvent | null;
  /** Set only when event is null. */
  skipReason?: StreamSkipReason;
  /** Raw driver.id, when available, even on skip — used for skip logging. */
  externalDriverId?: string;
  /** Raw behaviorLabels[].label values observed, when available — used for skip logging. */
  observedLabels?: string[];
}

/**
 * Converts a v2 stream safety event into a NormalizedProviderEvent.
 *
 * Returns { event: null, skipReason } when:
 *   - The event has no driver ID            (no_driver_id)
 *   - None of the behaviorLabels map to a supported DriverEventType (unsupported_behavior_label)
 *   - The event has no startMs/createdAtTime (no_timestamp)
 *   - Any unexpected error occurs            (unexpected_error)
 *
 * Never throws.
 */
export function normalizeSafetyStreamEvent(
  event: SamsaraSafetyStreamEvent
): NormalizeStreamResult {
  try {
    // --- Required: external driver ID ---
    // TODO: Confirm field path — observed as event.driver.id in insuretech docs.
    const externalDriverId = event.driver?.id;
    if (!externalDriverId) {
      // Skip is logged once, by the caller, as a structured entry (see route.ts).
      return { event: null, skipReason: "no_driver_id" };
    }

    // --- Event type: first behaviorLabel that maps to a supported DriverEventType ---
    // An event may have multiple labels (e.g., HarshBrake + AggressiveDriving).
    // We take the first supported match. Unknown labels are silently skipped here;
    // only the whole event is logged if NO label matches at all.
    // TODO: Confirm behaviorLabels[].label casing matches SAMSARA_TYPE_MAP keys.
    //       Observed: camelCase ("harshBrake", "mobileUsage") in insuretech examples.
    const labels = event.behaviorLabels ?? [];
    const observedLabels = labels.map((l) => l.label);
    let internalType: DriverEventType | undefined;

    for (const bl of labels) {
      const mapped = SAMSARA_TYPE_MAP[bl.label];
      if (mapped) {
        internalType = mapped;
        break;
      }
    }

    if (!internalType) {
      // Skip is logged once, by the caller, as a structured entry (see route.ts).
      return {
        event: null,
        skipReason: "unsupported_behavior_label",
        externalDriverId,
        observedLabels,
      };
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
      // Skip is logged once, by the caller, as a structured entry (see route.ts).
      return { event: null, skipReason: "no_timestamp", externalDriverId, observedLabels };
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

    return { event: normalized };
  } catch (err) {
    // Catch-all: normalization must never crash the sync route
    console.error(
      `[normalizeStreamEvent] Unexpected error for event id="${event.id}":`,
      err
    );
    return { event: null, skipReason: "unexpected_error" };
  }
}

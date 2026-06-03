/**
 * lib/providers/samsara/types.ts
 *
 * Minimal TypeScript stubs for the Samsara webhook payload envelope.
 *
 * These types are intentionally partial — only fields used for logging
 * and routing are typed. Full Samsara payload schemas should be added
 * per event type as processing is implemented.
 *
 * TODO: Replace with the official Samsara SDK types or a full hand-typed
 *       schema once the pilot payload format is confirmed.
 *       Reference: https://developers.samsara.com/docs/webhooks
 */

/** Top-level envelope common to all Samsara webhook events. */
export interface SamsaraWebhookEnvelope {
  /**
   * Event type identifier, e.g.:
   *   "VehicleLocation", "DriverHos", "SafetyEvent",
   *   "VehicleStat", "DocumentSubmitted"
   * TODO: Confirm exact string values against Samsara webhook event catalog.
   */
  eventType?: string;

  /**
   * Samsara-generated unique event ID.
   * Use for deduplication once event processing is implemented.
   * TODO: Confirm field name — may be "eventId" or "id" in actual payload.
   */
  eventId?: string;

  /**
   * Samsara organisation ID the event originated from.
   * Maps to ProviderAccount.externalOrgId for account resolution.
   * TODO: Confirm field name — may be "orgId" or nested under "organization".
   */
  orgId?: string;

  /**
   * Event-specific data payload.
   * Shape varies by eventType — all fields are optional to be safe.
   * TODO: Add discriminated union per eventType when processing begins.
   */
  data?: SamsaraEventData;

  /** Catch-all for any additional top-level fields in the real payload. */
  [key: string]: unknown;
}

/**
 * Common data fields across Samsara event types.
 * Many fields will be absent depending on the event type.
 *
 * TODO: Expand into per-event-type discriminated unions as processing is added.
 *       e.g., SamsaraHosEventData, SamsaraSafetyEventData, etc.
 */
export interface SamsaraEventData {
  driver?: {
    /** Samsara's internal driver ID — maps to DriverProviderMapping.externalDriverId */
    id?: string;
    name?: string;
    externalIds?: Record<string, string>;
  };
  vehicle?: {
    /** Samsara's internal vehicle ID — maps to DriverProviderMapping.externalVehicleId */
    id?: string;
    name?: string;
    externalIds?: Record<string, string>;
  };
  /** Catch-all for event-specific fields not yet typed. */
  [key: string]: unknown;
}

/**
 * Extracts the minimal routing metadata from any Samsara payload.
 * Used by the webhook route to populate WebhookLog without assuming event shape.
 */
export function extractSamsaraMetadata(payload: SamsaraWebhookEnvelope): {
  eventType: string | null;
  externalDriverId: string | null;
} {
  return {
    // TODO: Confirm this field path against actual Samsara payloads.
    eventType: payload.eventType ?? null,
    // TODO: Confirm driver ID path — may be nested differently per event type.
    externalDriverId: payload.data?.driver?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Safety Events Stream v2 types
// ---------------------------------------------------------------------------
// Reference: https://developers.samsara.com/reference/getsafetyeventsv2stream
//
// The v2 stream differs from the webhook envelope in two key ways:
//   1. Event classification uses behaviorLabels[] (array) not a top-level eventType string.
//   2. The event id field is always present and guaranteed unique — safe for dedup.

/** One label entry within a safety event's behaviorLabels array. */
export interface SamsaraBehaviorLabel {
  /** Machine-readable camelCase label — maps directly to SAMSARA_TYPE_MAP keys. */
  label: string;
  /** "automated" | "manual" | etc. */
  source?: string;
  /** Human-readable display name, e.g. "Harsh Brake". */
  name?: string;
}

/**
 * One safety event object returned by the v2 Safety Events Stream.
 * id is required per the Samsara schema; all other fields may be absent.
 *
 * TODO: Validate all field paths against a real pilot API response.
 *       Field names match Samsara's published schema as of mid-2025.
 */
export interface SamsaraSafetyStreamEvent {
  /** Unique event identifier — always present. Used as externalEventId for dedup. */
  id: string;
  /** Event time in RFC 3339 format. */
  time: string;
  /** Classification labels — first supported label becomes the DriverEventType. */
  behaviorLabels?: SamsaraBehaviorLabel[];
  /** "low" | "medium" | "high" | "critical" */
  severity?: string;
  driver?: {
    id?: string;
    name?: string;
    externalIds?: Record<string, string>;
  };
  vehicle?: {
    id?: string;
    name?: string;
    externalIds?: Record<string, string>;
  };
  location?: {
    latitude?: number;
    longitude?: number;
    formattedAddress?: string;
  };
  /** Catch-all for fields we don't process but want preserved in rawPayload. */
  [key: string]: unknown;
}

/** Top-level response envelope from the Safety Events Stream endpoint. */
export interface SamsaraSafetyStreamResponse {
  data: SamsaraSafetyStreamEvent[];
  pagination: {
    /** Opaque cursor — pass as `after` param to fetch the next page. */
    endCursor: string;
    hasNextPage: boolean;
  };
}

/**
 * Extracts the provider-side deduplication ID from a Samsara payload.
 * Returns null if no ID can be found — events without IDs cannot be deduplicated.
 *
 * TODO: Confirm the exact field name(s) against Samsara's webhook documentation.
 *       Observed candidates:
 *         payload.eventId        — top-level event UUID
 *         payload.data?.id       — event-specific ID nested under data
 *       Test with a real Samsara safety event payload before relying on this.
 */
export function extractExternalEventId(
  payload: SamsaraWebhookEnvelope
): string | null {
  if (typeof payload.eventId === "string" && payload.eventId.length > 0) {
    return payload.eventId;
  }
  const dataId = payload.data?.["id"];
  if (typeof dataId === "string" && dataId.length > 0) {
    return dataId;
  }
  return null;
}

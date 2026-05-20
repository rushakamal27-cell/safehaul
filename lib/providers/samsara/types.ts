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

/**
 * lib/providers/samsara/normalizeEvent.ts
 *
 * Converts a raw Samsara webhook payload into one or more provider-neutral
 * NormalizedProviderEvent objects consumed by the DriverEvent persistence layer.
 *
 * Design rules:
 *   - NEVER throw — return an empty array on any parse failure
 *   - NEVER reference Samsara-specific field names outside this file
 *   - Log warnings for unexpected structures so they are visible without crashing
 *   - Return an array for future batch support (Samsara is currently 1 event : 1 webhook)
 *
 * All field path assumptions are marked TODO so they can be corrected against
 * the actual Samsara webhook payload when testing with real events begins.
 */

import type { SamsaraWebhookEnvelope } from "./types";

// ---------------------------------------------------------------------------
// Internal event type union — the stable SafeHaul contract
// ---------------------------------------------------------------------------

export type DriverEventType =
  | "harsh_accel"
  | "harsh_braking"
  | "harsh_turn"
  | "high_speed_power_loss"
  | "inattentive_driving"
  | "mobile_usage"
  | "speeding"
  | "rolling_stop"
  | "following_distance"
  | "forward_collision_warning"
  | "crash";

/** Provider-neutral normalized event ready for DriverEvent persistence. */
export interface NormalizedProviderEvent {
  externalDriverId:  string;
  /** Raw driver display name as reported by the provider, when present. Feeds
   *  Driver.canonicalName sync — see lib/driverIdentity.ts. */
  driverName?:       string;
  externalVehicleId?: string;
  externalEventId?:  string;   // provider's own dedup ID
  type:              DriverEventType;
  severity:          number;   // normalized 1–5 (float)
  timestamp:         string;   // ISO 8601, from provider
  lat?:              number;
  lng?:              number;
}

// ---------------------------------------------------------------------------
// Samsara → internal event type mapping
// ---------------------------------------------------------------------------
// Exported so the stream normalizer (normalizeStreamEvent.ts) can reuse it
// without duplicating the mapping table.
//
// TODO: Validate these string values against Samsara's webhook event catalog.
//       Samsara uses PascalCase type names in some API versions and camelCase
//       in others. Both variants are listed here as a safety measure.
//       The v2 Safety Events Stream uses camelCase behaviorLabels[].label values.
//       Reference: https://developers.samsara.com/docs/safety-events
export const SAMSARA_TYPE_MAP: Readonly<Record<string, DriverEventType>> = {
  // PascalCase variants (Samsara webhook v1 observed format)
  HarshAccel:            "harsh_accel",
  HarshAcceleration:     "harsh_accel",
  HarshBrake:            "harsh_braking",
  HarshBraking:          "harsh_braking",
  HarshTurn:             "harsh_turn",
  HighSpeedPowerLoss:    "high_speed_power_loss",
  Inattentive:           "inattentive_driving",
  InattentiveDriving:    "inattentive_driving",
  MobileUsage:           "mobile_usage",
  // camelCase variants — TODO: confirm which version Samsara sends
  harshAccel:            "harsh_accel",
  harshAcceleration:     "harsh_accel",
  harshBrake:            "harsh_braking",
  harshBraking:          "harsh_braking",
  harshTurn:             "harsh_turn",
  highSpeedPowerLoss:    "high_speed_power_loss",
  inattentive:           "inattentive_driving",
  inattentiveDriving:    "inattentive_driving",
  mobileUsage:           "mobile_usage",

  // v2 Safety Events Stream labels. PascalCase confirmed against real pilot org data
  // (2026-07-12); camelCase added defensively, same as the original 6 types above —
  // only PascalCase has actually been observed from this API so far.
  // Samsara's v2 behaviorLabels enum has NO "HarshBrake"/"HarshBraking" member — only
  // "Braking" — while "HarshTurn" is still present unchanged. This is the same
  // g-force-threshold "Harsh Event Detection" family Samsara docs describe for
  // braking/acceleration/turning; "Braking" is treated as the v2 rename of harsh_braking.
  Braking:                 "harsh_braking",
  braking:                 "harsh_braking",
  // SevereSpeeding and MaxSpeed are distinct Samsara trigger conditions (relative-to-limit
  // vs absolute-limit) but both funnel into the existing "speeding" risk-engine bucket —
  // severity is not tiered by label name for either (Samsara omits `severity` on both).
  SevereSpeeding:          "speeding",
  severeSpeeding:          "speeding",
  MaxSpeed:                "speeding",
  maxSpeed:                "speeding",
  RollingStop:             "rolling_stop",
  rollingStop:             "rolling_stop",
  FollowingDistance:       "following_distance",
  followingDistance:       "following_distance",
  ForwardCollisionWarning: "forward_collision_warning",
  forwardCollisionWarning: "forward_collision_warning",
  // Confirmed live 2026-08-09 against a real pilot org event (Rushana,
  // 2026-08-07): a stored RawProviderEvent with behaviorLabels:
  // [{ label: "Crash", source: "SYSTEM" }] had no case here, so
  // normalizeSafetyStreamEvent correctly-but-silently skipped it
  // (skipReason "unsupported_behavior_label") — the raw payload was
  // preserved, but no DriverEvent was ever created. See
  // lib/riskEngine.ts's calcSafetyEventPenalties for why "crash" is
  // deliberately NOT scored (no case there either, by design — a crash is
  // an observed outcome, not treated as a predictive precursor yet).
  Crash:                   "crash",
  crash:                   "crash",
};

// ---------------------------------------------------------------------------
// Severity normalization
// ---------------------------------------------------------------------------
// TODO: Confirm Samsara's severity representation against their safety event docs.
//       Observed possibilities:
//         A) Numeric score 0–100 (scale to 1–5 by dividing into quintiles)
//         B) Categorical string: "mild" | "moderate" | "severe"
//         C) Absent (use event type to infer severity)
const SEVERITY_STRING_MAP: Readonly<Record<string, number>> = {
  low:      1,
  mild:     1,
  medium:   3,
  moderate: 3,
  high:     4,
  severe:   4,
  critical: 5,
};

export function normalizeSeverity(raw: unknown): number {
  if (typeof raw === "number" && isFinite(raw)) {
    // If in 0–100 range, scale to 1–5 quintiles
    if (raw >= 0 && raw <= 100) {
      return Math.min(5, Math.max(1, Math.ceil(raw / 20)));
    }
    // Already in 1–5 range — clamp and return
    return Math.min(5, Math.max(1, raw));
  }
  if (typeof raw === "string") {
    const mapped = SEVERITY_STRING_MAP[raw.toLowerCase()];
    if (mapped !== undefined) return mapped;
    console.warn(`[normalizeEvent] Unknown severity string: "${raw}" — defaulting to 3`);
  }
  // Default to medium when severity is absent or unrecognised
  return 3;
}

// ---------------------------------------------------------------------------
// Timestamp extraction
// ---------------------------------------------------------------------------
// TODO: Confirm the field name and format for event timestamps in Samsara payloads.
//       Observed candidates: data.time | data.eventMs | data.occurredAtMs (epoch ms)
function extractTimestamp(data: Record<string, unknown>): string {
  // Prefer ISO string if present
  if (typeof data["time"] === "string" && data["time"].length > 0) {
    return data["time"];
  }
  // Fall back to epoch ms → ISO
  if (typeof data["eventMs"] === "number") {
    return new Date(data["eventMs"]).toISOString();
  }
  if (typeof data["occurredAtMs"] === "number") {
    return new Date(data["occurredAtMs"]).toISOString();
  }
  // Last resort: use current time and log a warning
  console.warn("[normalizeEvent] No timestamp found in payload data — using receivedAt");
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Location extraction
// ---------------------------------------------------------------------------
// TODO: Confirm the exact field paths for lat/lng in Samsara safety event payloads.
//       Observed candidates: data.location.latitude/longitude | data.lat/lng
function extractLocation(
  data: Record<string, unknown>
): { lat?: number; lng?: number } {
  const loc = data["location"] as Record<string, unknown> | undefined;
  if (loc && typeof loc["latitude"] === "number" && typeof loc["longitude"] === "number") {
    return { lat: loc["latitude"], lng: loc["longitude"] };
  }
  // Alternative flat-field format
  if (typeof data["lat"] === "number" && typeof data["lng"] === "number") {
    return { lat: data["lat"] as number, lng: data["lng"] as number };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Converts a raw Samsara webhook envelope into normalized provider events.
 *
 * Returns an empty array if:
 *   - The event type is not in the supported set
 *   - The payload is missing required fields (externalDriverId, eventType)
 *   - Any unexpected error occurs during extraction
 *
 * Never throws.
 */
export function normalizeSamsaraEvent(
  payload: SamsaraWebhookEnvelope
): NormalizedProviderEvent[] {
  try {
    // --- Event type ---
    const rawEventType = payload.eventType;
    if (!rawEventType) {
      console.warn("[normalizeEvent] Payload missing eventType — skipping");
      return [];
    }

    const internalType = SAMSARA_TYPE_MAP[rawEventType];
    if (!internalType) {
      // Unknown event type — silently ignore (not an error, just unsupported)
      console.info(
        `[normalizeEvent] Unsupported Samsara eventType: "${rawEventType}" — ignoring`
      );
      return [];
    }

    // --- Required: external driver ID ---
    const externalDriverId = payload.data?.driver?.id;
    if (!externalDriverId) {
      console.warn(
        `[normalizeEvent] No driver ID found for eventType "${rawEventType}" — skipping`
      );
      return [];
    }

    // --- Optional fields ---
    const externalVehicleId = payload.data?.vehicle?.id;
    const driverName = payload.data?.driver?.name;

    // TODO: Confirm the field name for Samsara's event dedup ID.
    //       May be payload.eventId, payload.data?.id, or absent entirely.
    const externalEventId =
      (payload.eventId as string | undefined) ??
      (payload.data?.["id"] as string | undefined) ??
      undefined;

    const data = (payload.data ?? {}) as Record<string, unknown>;
    const timestamp = extractTimestamp(data);
    const { lat, lng } = extractLocation(data);

    // TODO: Confirm the field path for severity in Samsara safety event payloads.
    //       May be data.severity | data.safetyEventScore | absent.
    const severity = normalizeSeverity(data["severity"] ?? data["safetyEventScore"]);

    const normalized: NormalizedProviderEvent = {
      externalDriverId,
      ...(driverName         ? { driverName }         : {}),
      ...(externalVehicleId ? { externalVehicleId } : {}),
      ...(externalEventId   ? { externalEventId }   : {}),
      type: internalType,
      severity,
      timestamp,
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
    };

    return [normalized];
  } catch (err) {
    // Catch-all: normalization must never crash the webhook route
    console.error("[normalizeEvent] Unexpected error during normalization:", err);
    return [];
  }
}

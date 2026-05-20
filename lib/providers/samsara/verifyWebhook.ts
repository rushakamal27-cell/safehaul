/**
 * lib/providers/samsara/verifyWebhook.ts
 *
 * HMAC-SHA256 signature and timestamp verification for Samsara webhooks.
 *
 * Security properties:
 *   - Timing-safe comparison via crypto.timingSafeEqual (prevents timing oracle)
 *   - 5-minute replay window via timestamp check
 *   - Missing secret → config error (500), not auth failure (401)
 *   - Strips optional "sha256=" prefix for compatibility with both Samsara header formats
 *
 * Assumptions about Samsara's signature format (marked TODO where uncertain):
 *   - Signature header: X-Samsara-Signature (hex-encoded HMAC-SHA256)
 *   - Timestamp header: X-Samsara-Timestamp (Unix seconds as a decimal string)
 *   - Signing message: raw request body bytes only (no timestamp prefix)
 *   TODO: Confirm the exact signing message format against Samsara webhook docs.
 *         Some providers sign "{timestamp}.{rawBody}" — adjust SIGNING_MESSAGE if needed.
 *   TODO: Confirm timestamp unit (seconds vs milliseconds) against Samsara docs.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Maximum age of an accepted webhook in seconds. Rejects replays beyond this window. */
const MAX_AGE_SECONDS = 300; // 5 minutes

/** Structured error for verification failures. Carries a machine-readable code. */
export class WebhookVerificationError extends Error {
  constructor(
    public readonly code: WebhookErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export type WebhookErrorCode =
  | "MISSING_SECRET"       // SAMSARA_WEBHOOK_SECRET env var not set
  | "MISSING_SIGNATURE"    // X-Samsara-Signature header absent
  | "MISSING_TIMESTAMP"    // X-Samsara-Timestamp header absent
  | "INVALID_TIMESTAMP"    // timestamp is not a parseable number
  | "STALE_TIMESTAMP"      // timestamp is outside the replay window
  | "INVALID_SIGNATURE"    // signature format is unrecognisable
  | "SIGNATURE_MISMATCH";  // HMAC does not match

/**
 * Verifies a Samsara webhook request.
 *
 * @param rawBody   - Exact bytes of the request body (must NOT be pre-parsed)
 * @param signature - Value of X-Samsara-Signature header (null if absent)
 * @param timestamp - Value of X-Samsara-Timestamp header (null if absent)
 *
 * Throws WebhookVerificationError on any failure.
 * Returns void on success.
 */
export function verifySamsaraWebhook(
  rawBody: Buffer,
  signature: string | null,
  timestamp: string | null
): void {
  // --- Guard: secret must be configured ---
  const secret = process.env.SAMSARA_WEBHOOK_SECRET;
  if (!secret) {
    throw new WebhookVerificationError(
      "MISSING_SECRET",
      "SAMSARA_WEBHOOK_SECRET is not configured"
    );
  }

  // --- Guard: required headers must be present ---
  if (!signature) {
    throw new WebhookVerificationError(
      "MISSING_SIGNATURE",
      "X-Samsara-Signature header is required"
    );
  }
  if (!timestamp) {
    throw new WebhookVerificationError(
      "MISSING_TIMESTAMP",
      "X-Samsara-Timestamp header is required"
    );
  }

  // --- Timestamp freshness check (replay prevention) ---
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    throw new WebhookVerificationError(
      "INVALID_TIMESTAMP",
      `X-Samsara-Timestamp is not a valid integer: "${timestamp}"`
    );
  }

  // TODO: If Samsara sends milliseconds instead of seconds, divide ts by 1000 here.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) {
    throw new WebhookVerificationError(
      "STALE_TIMESTAMP",
      `Webhook timestamp is ${Math.abs(nowSeconds - ts)}s old (max ${MAX_AGE_SECONDS}s)`
    );
  }

  // --- HMAC-SHA256 computation ---
  // TODO: If Samsara signs "{timestamp}.{rawBody}", replace rawBody below with:
  //   Buffer.concat([Buffer.from(`${timestamp}.`), rawBody])
  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Strip optional "sha256=" prefix — some Samsara gateway versions include it
  const normalizedSig = signature.startsWith("sha256=")
    ? signature.slice(7)
    : signature;

  // --- Timing-safe comparison ---
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(normalizedSig, "hex");
  } catch {
    throw new WebhookVerificationError(
      "INVALID_SIGNATURE",
      "X-Samsara-Signature is not valid hex"
    );
  }

  const expectedBuf = Buffer.from(expected, "hex");

  // Buffers must be the same length for timingSafeEqual; length mismatch means mismatch.
  if (
    expectedBuf.length !== sigBuf.length ||
    !timingSafeEqual(expectedBuf, sigBuf)
  ) {
    throw new WebhookVerificationError(
      "SIGNATURE_MISMATCH",
      "X-Samsara-Signature does not match the computed HMAC"
    );
  }
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderId } from "../providerIds";

// Shared normalization for external/provider identifiers read out of our own
// DB. Motivated by a real incident (2026-09-01): a pilot's stored
// externalVehicleId was "\r\n281474980432129" — a CRLF artifact from
// out-of-band provisioning — which failed the all-digits Samsara-ID check and
// silently downgraded vehicle resolution. The same contamination on
// externalDriverId would be sent to Samsara as a query parameter and used as
// the event-attribution lookup key.

describe("normalizeProviderId", () => {
  test("strips a leading CRLF (the real Luka contamination)", () => {
    assert.equal(normalizeProviderId("\r\n281474980432129"), "281474980432129");
  });

  test("strips a bare CR and a bare LF", () => {
    assert.equal(normalizeProviderId("\r281474980432129"), "281474980432129");
    assert.equal(normalizeProviderId("281474980432129\n"), "281474980432129");
  });

  test("strips tabs and ordinary spaces on both sides", () => {
    assert.equal(normalizeProviderId("\t281474980432129\t"), "281474980432129");
    assert.equal(normalizeProviderId("  281474980432129  "), "281474980432129");
  });

  test("a clean ID is returned byte-for-byte unchanged", () => {
    const id = "281474980432129";
    const out = normalizeProviderId(id);
    assert.equal(out, id);
    assert.equal(out?.length, 15);
  });

  test("large Samsara IDs stay exact strings — never parsed as numbers", () => {
    // 18 digits: beyond Number.MAX_SAFE_INTEGER, would lose precision if
    // round-tripped through a JS number.
    const id = "281474991238949123";
    const out = normalizeProviderId(`\r\n${id}`);
    assert.equal(out, id);
    assert.equal(typeof out, "string");
  });

  test("interior characters are never touched (no de-spacing, no case change)", () => {
    assert.equal(normalizeProviderId("  281 474980432129  "), "281 474980432129");
    assert.equal(normalizeProviderId("TRUCK 226 (IDEAL)"), "TRUCK 226 (IDEAL)");
  });

  test("null/undefined pass through as null", () => {
    assert.equal(normalizeProviderId(null), null);
    assert.equal(normalizeProviderId(undefined), null);
  });

  test("an all-whitespace value is absent data, not an identifier", () => {
    assert.equal(normalizeProviderId("   "), null);
    assert.equal(normalizeProviderId("\r\n"), null);
    assert.equal(normalizeProviderId(""), null);
  });
});

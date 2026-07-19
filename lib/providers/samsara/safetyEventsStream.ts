/**
 * lib/providers/samsara/safetyEventsStream.ts
 *
 * HTTP client for the Samsara Safety Events Stream v2 API.
 *
 * GET /safety-events/stream
 *
 * Uses cursor-based pagination: call with afterCursor=undefined for the first
 * page, then pass pagination.endCursor as afterCursor on each subsequent call
 * until hasNextPage is false.
 *
 * IMPORTANT (fixed 2026-07-18): `startTime` is REQUIRED on every request,
 * including cursor-continuation requests — confirmed against Samsara's API
 * reference (developers.samsara.com/reference/getsafetyeventsv2stream, which
 * documents `after` as working *alongside* `startTime`, not replacing it) and
 * by live testing: omitting `startTime` when `after` is set returns a 400
 * `"startTime" is missing from query string`, even for a cursor issued
 * moments earlier. The previous implementation treated `afterCursor` and
 * `startTime` as mutually exclusive, which made every multi-page drain fail
 * on page 2 with this validation error — silently misdiagnosed by the caller
 * as an expired cursor (see syncSafetyEvents.ts for the corresponding fix).
 * Always pass both when continuing pagination.
 */

import type { SamsaraSafetyStreamResponse } from "./types";

const SAMSARA_API_BASE = "https://api.samsara.com";

// Verified against: https://developers.samsara.com/reference/getsafetyeventsv2stream
// Samsara's next-gen API does NOT use the /fleet/ prefix.
const STREAM_PATH = "/safety-events/stream";

export interface FetchSafetyEventsParams {
  /** Pagination cursor from a previous response. Sent alongside startTime, not instead of it. */
  afterCursor?: string;
  /**
   * ISO 8601 start time — required on every request per Samsara's API
   * (see file header). Callers should resolve one stable value per sync
   * drain and reuse it for every page, cold-start or continuation.
   */
  startTime: string;
  /**
   * Samsara external driver IDs to pre-filter the stream.
   * Passing only pilot driver IDs avoids fetching events for the whole fleet.
   * Max 2000 per Samsara's API documentation.
   */
  driverIds?: string[];
  /** Optional abort signal — lets callers enforce a bounded wait (e.g. on-demand sync). */
  signal?: AbortSignal;
}

/** Structured error for Samsara API HTTP failures. */
export class SamsaraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
    message: string
  ) {
    super(message);
    this.name = "SamsaraApiError";
  }
}

/**
 * Pure — builds the Samsara Safety Events Stream request URL. `startTime` is
 * always included when provided; `after` is added on top of it (not instead)
 * for continuation requests. See file header for why both are required
 * together.
 */
export function buildSafetyEventsStreamUrl(params: FetchSafetyEventsParams): string {
  const url = new URL(`${SAMSARA_API_BASE}${STREAM_PATH}`);

  url.searchParams.set("startTime", params.startTime);

  if (params.afterCursor) {
    url.searchParams.set("after", params.afterCursor);
  }

  // Filter to pilot drivers only — reduces data transfer for large fleets
  if (params.driverIds && params.driverIds.length > 0) {
    url.searchParams.set("driverIds", params.driverIds.join(","));
  }

  // Use createdAtTime so the cursor tracks new events, not coaching-state updates.
  // Without this, default is updatedAtTime which would re-surface old events on edits.
  url.searchParams.set("queryByTimeField", "createdAtTime");

  return url.toString();
}

/**
 * Fetches one page of safety events from the Samsara stream.
 *
 * Throws SamsaraApiError on non-2xx responses (including genuine stale-cursor
 * errors). Callers should catch SamsaraApiError and classify the failure
 * (see syncSafetyEvents.ts's isCursorSpecificError) rather than assuming
 * every 400/422 means the cursor expired.
 *
 * Never retries — retry policy belongs in the caller (the sync route).
 */
export async function fetchSamsaraSafetyEvents(
  params: FetchSafetyEventsParams
): Promise<SamsaraSafetyStreamResponse> {
  const token = process.env.SAMSARA_API_TOKEN;
  if (!token) {
    throw new Error("[safetyEventsStream] SAMSARA_API_TOKEN is not configured");
  }

  const url = buildSafetyEventsStreamUrl(params);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    // Prevent Next.js from caching this — it must always hit the live API
    cache: "no-store",
    signal: params.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SamsaraApiError(
      response.status,
      body,
      `Samsara Safety Events Stream returned ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<SamsaraSafetyStreamResponse>;
}

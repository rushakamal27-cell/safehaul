/**
 * lib/providers/samsara/safetyEventsStream.ts
 *
 * HTTP client for the Samsara Safety Events Stream v2 API.
 *
 * GET /fleet/safety-events/stream
 *
 * Uses cursor-based pagination: call with afterCursor=undefined for the first
 * page (pass startTime instead), then pass pagination.endCursor on each
 * subsequent call until hasNextPage is false.
 *
 * TODO: Confirm the exact endpoint path against the Samsara dashboard API explorer
 *       once pilot API access is available.
 */

import type { SamsaraSafetyStreamResponse } from "./types";

const SAMSARA_API_BASE = "https://api.samsara.com";

// TODO: Confirm path — Samsara developer portal reference: getsafetyeventsv2stream
const STREAM_PATH = "/fleet/safety-events/stream";

export interface FetchSafetyEventsParams {
  /** Pagination cursor from a previous response. Mutually exclusive with startTime. */
  afterCursor?: string;
  /**
   * ISO 8601 start time — only used on the first fetch when no cursor exists.
   * Ignored if afterCursor is provided.
   */
  startTime?: string;
  /**
   * Samsara external driver IDs to pre-filter the stream.
   * Passing only pilot driver IDs avoids fetching events for the whole fleet.
   * Max 2000 per Samsara's API documentation.
   */
  driverIds?: string[];
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
 * Fetches one page of safety events from the Samsara stream.
 *
 * Throws SamsaraApiError on non-2xx responses (including stale-cursor 400/422).
 * Callers should catch SamsaraApiError and handle stale cursor by resetting state.
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

  const url = new URL(`${SAMSARA_API_BASE}${STREAM_PATH}`);

  if (params.afterCursor) {
    // Cursor takes priority — startTime is ignored when a cursor is present
    url.searchParams.set("after", params.afterCursor);
  } else if (params.startTime) {
    url.searchParams.set("startTime", params.startTime);
  }

  // Filter to pilot drivers only — reduces data transfer for large fleets
  if (params.driverIds && params.driverIds.length > 0) {
    url.searchParams.set("driverIds", params.driverIds.join(","));
  }

  // Use createdAtTime so the cursor tracks new events, not coaching-state updates.
  // Without this, default is updatedAtTime which would re-surface old events on edits.
  url.searchParams.set("queryByTimeField", "createdAtTime");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    // Prevent Next.js from caching this — it must always hit the live API
    cache: "no-store",
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

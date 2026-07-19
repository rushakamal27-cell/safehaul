import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runSamsaraSafetyEventsSync,
  isCursorSpecificError,
  type PilotMappingClient,
  type SafetyEventsSyncStateClient,
} from "../syncSafetyEvents";
import { SamsaraApiError } from "../safetyEventsStream";
import type { SamsaraSafetyStreamResponse } from "../types";

// Regression coverage for two related fixes:
//   1. (2026-07-18) The sync used to treat every 400/422 from Samsara as an
//      expired cursor, which misclassified a generic validation error
//      (missing startTime on continuation requests — see
//      safetyEventsStream.test.ts) as cursor expiry and abandoned the run
//      with no retry.
//   2. (2026-07-18 follow-up) ProviderSyncState now persists cursorStartTime
//      alongside cursor, so a resumed drain reuses the *real* startTime a
//      cursor was established under instead of a synthesized one — with
//      explicit, safe handling for legacy rows that predate this field.
// Every dependency is faked in-memory — no real network or database access.

function jsonError(status: number, message: string): SamsaraApiError {
  return new SamsaraApiError(
    status,
    JSON.stringify({ message, requestId: "test-request-id" }),
    `Samsara Safety Events Stream returned ${status}`
  );
}

describe("isCursorSpecificError", () => {
  test("generic 400 missing-startTime error is NOT classified as stale cursor", () => {
    const err = jsonError(400, `"startTime" is missing from query string`);
    assert.equal(isCursorSpecificError(err), false);
  });

  test("400 with an invalid driverIds message is NOT classified as stale cursor", () => {
    const err = jsonError(400, `"driverIds" contains an invalid ID`);
    assert.equal(isCursorSpecificError(err), false);
  });

  test("401 auth error is NOT classified as stale cursor, regardless of message", () => {
    const err = jsonError(401, "invalid token");
    assert.equal(isCursorSpecificError(err), false);
  });

  test("429 rate-limit error is NOT classified as stale cursor", () => {
    const err = jsonError(429, "rate limit exceeded");
    assert.equal(isCursorSpecificError(err), false);
  });

  test("'cursor is required' references the cursor but has no invalidity wording — NOT classified", () => {
    const err = jsonError(400, "cursor is required");
    assert.equal(isCursorSpecificError(err), false);
  });

  test("'cursor format parameter is missing' references the cursor but has no invalidity wording — NOT classified", () => {
    const err = jsonError(400, "cursor format parameter is missing");
    assert.equal(isCursorSpecificError(err), false);
  });

  test("'request failed while processing cursor pagination' references the cursor but has no invalidity wording — NOT classified", () => {
    const err = jsonError(400, "request failed while processing cursor pagination");
    assert.equal(isCursorSpecificError(err), false);
  });

  test("a message explicitly mentioning 'cursor' AND 'invalid'/'expired' IS classified as stale cursor", () => {
    const err = jsonError(400, "The provided cursor is invalid or has expired");
    assert.equal(isCursorSpecificError(err), true);
  });

  test("a message mentioning 'after' + 'expired' IS classified as stale cursor", () => {
    const err = jsonError(422, "The after value has expired");
    assert.equal(isCursorSpecificError(err), true);
  });

  test("'cursor no longer valid' IS classified (multi-word invalidity phrase)", () => {
    const err = jsonError(422, "cursor no longer valid");
    assert.equal(isCursorSpecificError(err), true);
  });

  test("'cursor not found' IS classified", () => {
    const err = jsonError(400, "cursor not found");
    assert.equal(isCursorSpecificError(err), true);
  });

  test("422 status is eligible for stale-cursor classification, not just 400", () => {
    const err = jsonError(422, "cursor no longer valid");
    assert.equal(isCursorSpecificError(err), true);
  });

  test("500 with cursor-like wording is still NOT classified (only 400/422 are eligible)", () => {
    const err = jsonError(500, "cursor expired");
    assert.equal(isCursorSpecificError(err), false);
  });

  test("non-SamsaraApiError input is never classified as stale cursor", () => {
    assert.equal(isCursorSpecificError(new Error("cursor expired")), false);
    assert.equal(isCursorSpecificError("cursor expired"), false);
    assert.equal(isCursorSpecificError(null), false);
  });

  test("non-JSON response body falls back to raw-text matching", () => {
    const err = new SamsaraApiError(400, "cursor has expired", "Samsara returned 400");
    assert.equal(isCursorSpecificError(err), true);
  });
});

// ---------------------------------------------------------------------------
// runSamsaraSafetyEventsSync — fully injected, no real prisma/network access.
// Every test page carries data: [] so the (unchanged) per-event DB-writing
// path in processPage() never executes — only the pagination/retry/
// cursor+cursorStartTime control flow is under test.
// ---------------------------------------------------------------------------

function emptyPage(endCursor: string, hasNextPage: boolean): SamsaraSafetyStreamResponse {
  return { data: [], pagination: { endCursor, hasNextPage } };
}

function makeMappingClient(externalDriverIds: string[]): PilotMappingClient {
  return { findMany: async () => externalDriverIds.map((externalDriverId) => ({ externalDriverId })) };
}

function makeSyncStateClient(initialCursor: string | null, initialCursorStartTime: Date | null = null) {
  let cursor: string | null = initialCursor;
  let cursorStartTime: Date | null = initialCursorStartTime;
  let lastSyncAt: Date | null = null;
  const client: SafetyEventsSyncStateClient = {
    async findUnique() {
      return { cursor, cursorStartTime };
    },
    async upsert({ update }) {
      // The real implementation always writes both halves of the pair
      // together as concrete values (never `undefined`) — see
      // syncSafetyEvents.ts's checkpoint and reset call sites.
      cursor = update.cursor;
      cursorStartTime = update.cursorStartTime;
    },
    async update({ data }) {
      lastSyncAt = data.lastSyncAt;
    },
  };
  return {
    client,
    getCursor: () => cursor,
    getCursorStartTime: () => cursorStartTime,
    getLastSyncAt: () => lastSyncAt,
  };
}

describe("runSamsaraSafetyEventsSync — cold start (no saved cursor)", () => {
  test("first request has startTime, no after", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const { client: syncStateClient } = makeSyncStateClient(null);

    const seen: Array<{ startTime: string; afterCursor?: string }> = [];
    const fetchPage = async (params: { startTime: string; afterCursor?: string }) => {
      seen.push({ startTime: params.startTime, afterCursor: params.afterCursor });
      return emptyPage("cursor-1", false);
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, true);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].startTime, "startTime must be present");
    assert.equal(seen[0].afterCursor, undefined);
  });
});

describe("runSamsaraSafetyEventsSync — saved cursor + cursorStartTime pair (scenario A)", () => {
  test("both halves of a complete saved pair are reused verbatim on the resuming request", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const savedStartTime = new Date("2026-07-10T00:00:00.000Z");
    const { client: syncStateClient } = makeSyncStateClient("saved-cursor-xyz", savedStartTime);

    const seen: Array<{ startTime: string; afterCursor?: string }> = [];
    const fetchPage = async (params: { startTime: string; afterCursor?: string }) => {
      seen.push({ startTime: params.startTime, afterCursor: params.afterCursor });
      return emptyPage("next-cursor", false);
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].afterCursor, "saved-cursor-xyz", "the saved cursor must be reused, not dropped");
    assert.equal(
      seen[0].startTime,
      savedStartTime.toISOString(),
      "the saved cursorStartTime must be reused verbatim, not a freshly synthesized one"
    );
  });
});

describe("runSamsaraSafetyEventsSync — legacy cursor without a paired startTime (scenario B)", () => {
  test("legacy cursor (cursorStartTime null) is not sent as `after`; a safe bounded cold start runs instead", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const { client: syncStateClient, getCursor, getCursorStartTime } = makeSyncStateClient(
      "legacy-cursor-no-starttime",
      null
    );

    const seen: Array<{ startTime: string; afterCursor?: string }> = [];
    const fetchPage = async (params: { startTime: string; afterCursor?: string }) => {
      seen.push({ startTime: params.startTime, afterCursor: params.afterCursor });
      return emptyPage("fresh-cursor-after-legacy-recovery", false);
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, true);
    assert.equal(
      seen[0].afterCursor,
      undefined,
      "an incomplete (cursor-only) pair must never be sent as `after` — it can't be paired with a proven startTime"
    );
    assert.ok(seen[0].startTime, "a bounded cold-start startTime is still used");
    assert.equal(
      getCursor(),
      "fresh-cursor-after-legacy-recovery",
      "the legacy cursor is superseded once a page in the cold-start attempt succeeds"
    );
    assert.ok(getCursorStartTime() !== null, "the new cursor now has a real, paired cursorStartTime");
  });

  test("a failed legacy-recovery attempt leaves the legacy cursor untouched (nothing is destroyed before success)", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const { client: syncStateClient, getCursor, getCursorStartTime } = makeSyncStateClient(
      "legacy-cursor-no-starttime",
      null
    );

    const fetchPage = async () => {
      throw jsonError(500, "internal server error");
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, false);
    assert.equal(
      getCursor(),
      "legacy-cursor-no-starttime",
      "a failed recovery attempt (no page succeeded) must not destroy the legacy cursor"
    );
    assert.equal(getCursorStartTime(), null);
  });
});

describe("runSamsaraSafetyEventsSync — multi-page successful drain (scenario C/E)", () => {
  test("drains all pages, advances lastSyncAt, persists the final cursor+cursorStartTime pair, reuses one stable startTime", async () => {
    const mappingClient = makeMappingClient(["111", "222"]);
    const { client: syncStateClient, getCursor, getCursorStartTime, getLastSyncAt } = makeSyncStateClient(null);

    const seen: Array<{ startTime: string; afterCursor?: string }> = [];
    const pages = [emptyPage("cursor-page-1", true), emptyPage("cursor-page-2", false)];
    let call = 0;
    const fetchPage = async (params: { startTime: string; afterCursor?: string }) => {
      seen.push({ startTime: params.startTime, afterCursor: params.afterCursor });
      return pages[call++];
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, true);
    assert.equal(outcome.skipped, false);
    if (outcome.synced && !outcome.skipped) {
      assert.equal(outcome.cursor, "cursor-page-2");
    }
    assert.equal(getCursor(), "cursor-page-2");
    assert.ok(getLastSyncAt() !== null, "lastSyncAt must advance after a complete drain");
    assert.equal(
      getCursorStartTime()?.toISOString(),
      seen[0].startTime,
      "the persisted cursorStartTime must match the single startTime used for the whole drain"
    );

    assert.equal(seen.length, 2);
    assert.equal(seen[0].afterCursor, undefined, "page 1 (cold start) has no after");
    assert.equal(seen[1].afterCursor, "cursor-page-1", "page 2 continues from page 1's cursor");
    assert.equal(seen[1].startTime, seen[0].startTime, "startTime must stay stable across every page in the drain (not recomputed)");
  });
});

describe("runSamsaraSafetyEventsSync — generic second-page failure (scenario D)", () => {
  test("does not advance lastSyncAt, does not report success, preserves the checkpointed cursor+cursorStartTime pair", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const { client: syncStateClient, getCursor, getCursorStartTime, getLastSyncAt } = makeSyncStateClient(null);

    let call = 0;
    const fetchPage = async () => {
      call++;
      if (call === 1) return emptyPage("cursor-page-1", true);
      throw jsonError(500, "internal server error");
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, false);
    assert.equal(getLastSyncAt(), null, "lastSyncAt must not advance when the drain doesn't complete");
    assert.equal(
      getCursor(),
      "cursor-page-1",
      "page 1's successful checkpoint must survive a later generic failure"
    );
    assert.ok(getCursorStartTime() !== null, "page 1's checkpointed cursorStartTime must also survive");
    assert.equal(call, 2, "must not retry a generic (non-cursor) error");
  });

  test("generic 400 missing-startTime failure on first page: cursor + cursorStartTime both untouched, reported as failure", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const priorStartTime = new Date("2026-07-01T00:00:00.000Z");
    const { client: syncStateClient, getCursor, getCursorStartTime, getLastSyncAt } = makeSyncStateClient(
      "prior-valid-cursor",
      priorStartTime
    );

    const fetchPage = async () => {
      throw jsonError(400, `"startTime" is missing from query string`);
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, false);
    assert.equal(
      getCursor(),
      "prior-valid-cursor",
      "a generic validation error must never wipe a good stored cursor"
    );
    assert.equal(
      getCursorStartTime()?.getTime(),
      priorStartTime.getTime(),
      "a generic validation error must never wipe the paired cursorStartTime either"
    );
    assert.equal(getLastSyncAt(), null);
  });
});

describe("runSamsaraSafetyEventsSync — genuine stale-cursor recovery (scenario E)", () => {
  test("cursor error on attempt 1: clears cursor+cursorStartTime together, retries once via cold start, succeeds", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const priorStartTime = new Date("2026-07-01T00:00:00.000Z");
    const { client: syncStateClient, getCursor, getCursorStartTime, getLastSyncAt } = makeSyncStateClient(
      "expired-cursor",
      priorStartTime
    );

    let call = 0;
    const seenAfter: Array<string | undefined> = [];
    const fetchPage = async (params: { afterCursor?: string }) => {
      call++;
      seenAfter.push(params.afterCursor);
      if (call === 1) throw jsonError(400, "The provided cursor is invalid or has expired");
      return emptyPage("fresh-cursor", false);
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, true);
    assert.equal(call, 2, "exactly one retry after the cursor error");
    assert.equal(seenAfter[0], "expired-cursor");
    assert.equal(seenAfter[1], undefined, "the retry must cold-start with no after cursor");
    assert.equal(getCursor(), "fresh-cursor");
    assert.notEqual(
      getCursorStartTime()?.getTime(),
      priorStartTime.getTime(),
      "the retry's cold-start time must replace the old (expired-cursor-paired) startTime, not keep it"
    );
    assert.ok(getLastSyncAt() !== null);
  });

  test("cursor error persists on the retry too: both halves cleared consistently, fails after exactly one retry, never loops infinitely", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const { client: syncStateClient, getCursor, getCursorStartTime, getLastSyncAt } = makeSyncStateClient(
      "expired-cursor",
      new Date("2026-07-01T00:00:00.000Z")
    );

    let call = 0;
    const fetchPage = async () => {
      call++;
      throw jsonError(400, "cursor expired");
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, false);
    assert.equal(call, 2, "must stop after exactly one retry attempt, not loop forever");
    assert.equal(getCursor(), null, "cursor was genuinely invalid, so clearing it on give-up is correct");
    assert.equal(getCursorStartTime(), null, "cursorStartTime must be cleared in lockstep with cursor");
    assert.equal(getLastSyncAt(), null);
  });
});

describe("runSamsaraSafetyEventsSync — cross-invocation continuation (scenario F)", () => {
  test("a second, independent invocation resumes the exact cursor+startTime pair the first invocation saved", async () => {
    const mappingClient = makeMappingClient(["111"]);
    const { client: syncStateClient, getCursor, getCursorStartTime } = makeSyncStateClient(null);

    // Invocation 1: cold start, completes with a saved pair.
    const seen1: Array<{ startTime: string; afterCursor?: string }> = [];
    const outcome1 = await runSamsaraSafetyEventsSync(undefined, {
      mappingClient,
      syncStateClient,
      fetchPage: async (params) => {
        seen1.push({ startTime: params.startTime, afterCursor: params.afterCursor });
        return emptyPage("cursor-from-invocation-1", false);
      },
    });
    assert.equal(outcome1.synced, true);

    const savedCursor = getCursor();
    const savedCursorStartTime = getCursorStartTime();
    assert.equal(savedCursor, "cursor-from-invocation-1");
    assert.ok(savedCursorStartTime !== null);

    // Invocation 2: a brand-new call (simulating a later, separate /api/risk
    // request) sharing only the persisted ProviderSyncState row — must
    // resume with exactly what invocation 1 left behind, not a guess.
    const seen2: Array<{ startTime: string; afterCursor?: string }> = [];
    const outcome2 = await runSamsaraSafetyEventsSync(undefined, {
      mappingClient,
      syncStateClient,
      fetchPage: async (params) => {
        seen2.push({ startTime: params.startTime, afterCursor: params.afterCursor });
        return emptyPage("cursor-from-invocation-2", false);
      },
    });

    assert.equal(outcome2.synced, true);
    assert.equal(seen2[0].afterCursor, savedCursor);
    assert.equal(seen2[0].startTime, savedCursorStartTime?.toISOString());
  });
});

describe("runSamsaraSafetyEventsSync — no pilot drivers", () => {
  test("skips the sync entirely when no active pilot mapping exists", async () => {
    const mappingClient = makeMappingClient([]);
    const { client: syncStateClient } = makeSyncStateClient(null);
    let fetchCalls = 0;
    const fetchPage = async () => {
      fetchCalls++;
      return emptyPage("x", false);
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient,
      syncStateClient,
    });

    assert.equal(outcome.synced, true);
    if (outcome.synced && outcome.skipped) {
      assert.equal(outcome.reason, "no_pilot_drivers");
    }
    assert.equal(fetchCalls, 0);
  });
});

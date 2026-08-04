import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runSamsaraSafetyEventsSync,
  isCursorSpecificError,
  type PilotMappingClient,
  type SafetyEventsSyncStateClient,
} from "../syncSafetyEvents";
import { SamsaraApiError } from "../safetyEventsStream";
import type { SamsaraSafetyStreamResponse, SamsaraSafetyStreamEvent } from "../types";
import { prisma } from "@/lib/prisma";

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

  // 2026-08-04 pagination incident: Samsara's exact wording for a
  // cursor/query-binding mismatch (e.g. a differently-ordered driverIds
  // string) never mentions "cursor" or "after" — see CURSOR_PARAMETER_MISMATCH_PHRASE.
  test("'Parameters differ from previous paginated request.' (Samsara's exact production wording) IS classified as a cursor error", () => {
    const err = jsonError(400, "Parameters differ from previous paginated request.");
    assert.equal(isCursorSpecificError(err), true);
  });

  test("the parameter-mismatch phrase is matched case-insensitively", () => {
    const err = jsonError(400, "PARAMETERS DIFFER FROM PREVIOUS PAGINATED REQUEST.");
    assert.equal(isCursorSpecificError(err), true);
  });

  test("a similar-but-different 'parameters' message is NOT classified — the match is narrow, not a broad 'parameters' substring", () => {
    const err = jsonError(400, "Parameters are invalid for this request");
    assert.equal(isCursorSpecificError(err), false);
  });

  test("422 status is also eligible for the parameter-mismatch phrase, not just 400", () => {
    const err = jsonError(422, "Parameters differ from previous paginated request.");
    assert.equal(isCursorSpecificError(err), true);
  });

  test("500 with the parameter-mismatch phrase is still NOT classified (only 400/422 are eligible)", () => {
    const err = jsonError(500, "Parameters differ from previous paginated request.");
    assert.equal(isCursorSpecificError(err), false);
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

// ---------------------------------------------------------------------------
// 2026-08-04 pagination incident regression coverage.
//
// Root cause: pilot driver IDs were loaded via an unordered Prisma
// findMany() and joined into the `driverIds` query parameter as-is.
// Postgres gives no ordering guarantee without ORDER BY, so the exact same
// pilot SET could serialize into a different comma-joined string across two
// otherwise-identical sync invocations. Samsara binds a pagination cursor to
// the literal parameter string used to mint it, so a reordered (but
// unchanged) driverIds value made a perfectly good, unexpired cursor
// unusable — confirmed live: resending the exact stuck cursor+startTime
// with only driverIds' order swapped flipped Samsara's response from 400
// "Parameters differ from previous paginated request." to 200.
// ---------------------------------------------------------------------------

describe("runSamsaraSafetyEventsSync — deterministic driverIds ordering (2026-08-04 incident)", () => {
  test("the same pilot driver SET returned in a different order still produces the same driverIds request value", async () => {
    const { client: syncStateClient1 } = makeSyncStateClient(null);
    const seenA: Array<string[] | undefined> = [];
    await runSamsaraSafetyEventsSync(undefined, {
      mappingClient: makeMappingClient(["222", "111", "333"]),
      syncStateClient: syncStateClient1,
      fetchPage: async (params) => {
        seenA.push(params.driverIds);
        return emptyPage("cursor-a", false);
      },
    });

    const { client: syncStateClient2 } = makeSyncStateClient(null);
    const seenB: Array<string[] | undefined> = [];
    await runSamsaraSafetyEventsSync(undefined, {
      mappingClient: makeMappingClient(["333", "111", "222"]),
      syncStateClient: syncStateClient2,
      fetchPage: async (params) => {
        seenB.push(params.driverIds);
        return emptyPage("cursor-b", false);
      },
    });

    assert.deepEqual(seenA[0], ["111", "222", "333"], "driverIds must be sorted, not passed through in Prisma's return order");
    assert.deepEqual(
      seenB[0],
      seenA[0],
      "the same pilot SET in a different input order must serialize to an identical driverIds request value"
    );
  });

  test("ordering is stable across every page of a multi-page drain, not just page 1", async () => {
    const { client: syncStateClient } = makeSyncStateClient(null);
    const seen: Array<string[] | undefined> = [];
    const pages = [emptyPage("cursor-page-1", true), emptyPage("cursor-page-2", false)];
    let call = 0;
    await runSamsaraSafetyEventsSync(undefined, {
      mappingClient: makeMappingClient(["222", "111"]),
      syncStateClient,
      fetchPage: async (params) => {
        seen.push(params.driverIds);
        return pages[call++];
      },
    });

    assert.deepEqual(seen[0], ["111", "222"]);
    assert.deepEqual(seen[1], ["111", "222"]);
  });
});

describe("runSamsaraSafetyEventsSync — parameter-mismatch cursor recovery (2026-08-04 incident)", () => {
  test("a saved cursor failing with Samsara's parameter-mismatch wording is cleared and retried exactly once via cold start, using deterministic driverIds", async () => {
    const priorStartTime = new Date("2026-07-18T00:24:12.508Z");
    const { client: syncStateClient, getCursor, getCursorStartTime, getLastSyncAt } = makeSyncStateClient(
      "stuck-cursor",
      priorStartTime
    );

    let call = 0;
    const seenAfter: Array<string | undefined> = [];
    const seenDriverIds: Array<string[] | undefined> = [];
    const fetchPage = async (params: { afterCursor?: string; driverIds?: string[] }) => {
      call++;
      seenAfter.push(params.afterCursor);
      seenDriverIds.push(params.driverIds);
      if (call === 1) throw jsonError(400, "Parameters differ from previous paginated request.");
      return emptyPage("fresh-cursor-after-recovery", false);
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient: makeMappingClient(["222", "111"]),
      syncStateClient,
    });

    assert.equal(outcome.synced, true, "the retry must succeed");
    assert.equal(call, 2, "exactly one retry — never loops");
    assert.equal(seenAfter[0], "stuck-cursor", "the first attempt still tries the saved cursor");
    assert.equal(seenAfter[1], undefined, "the retry must cold-start with no after cursor");
    assert.equal(getCursor(), "fresh-cursor-after-recovery", "the stuck cursor is replaced once the retry succeeds");
    assert.notEqual(
      getCursorStartTime()?.getTime(),
      priorStartTime.getTime(),
      "the retry's cold-start time replaces the old, now-untrustworthy startTime"
    );
    assert.ok(getLastSyncAt() !== null);

    assert.deepEqual(seenDriverIds[0], ["111", "222"], "even the failing first attempt already used deterministic ordering");
    assert.deepEqual(seenDriverIds[1], ["111", "222"], "the retry reuses the same deterministic driverIds — no re-derivation, no reordering");
  });

  test("the parameter-mismatch phrase does not loop forever if it recurs on the retry too", async () => {
    const { client: syncStateClient, getCursor, getCursorStartTime, getLastSyncAt } = makeSyncStateClient(
      "stuck-cursor",
      new Date("2026-07-18T00:24:12.508Z")
    );

    let call = 0;
    const fetchPage = async () => {
      call++;
      throw jsonError(400, "Parameters differ from previous paginated request.");
    };

    const outcome = await runSamsaraSafetyEventsSync(undefined, {
      fetchPage,
      mappingClient: makeMappingClient(["111"]),
      syncStateClient,
    });

    assert.equal(outcome.synced, false);
    assert.equal(call, 2, "must stop after exactly one retry attempt");
    assert.equal(getCursor(), null, "both halves are cleared on give-up, same as any other genuine cursor error");
    assert.equal(getCursorStartTime(), null);
    assert.equal(getLastSyncAt(), null);
  });
});

describe("runSamsaraSafetyEventsSync — deduplication safety (cold-start re-fetch)", () => {
  // processPage() (inside syncSafetyEvents.ts) talks to prisma.rawProviderEvent
  // / prisma.driverProviderMapping / prisma.driverEvent directly — it has no
  // injectable client, unlike mappingClient/syncStateClient above. Node's
  // t.mock.method() can't stub these: Prisma 5's client delegates are Proxy-
  // wrapped, and Object.getOwnPropertyDescriptor(delegate, "findUnique")
  // reports { value: undefined, ... } even though the property resolves to a
  // real function on normal access (confirmed by direct inspection) —
  // t.mock.method relies on that descriptor to capture the "original" method
  // and throws ERR_INVALID_ARG_VALUE on this shape. Plain property
  // reassignment (delegate.findUnique = fn) goes through the Proxy's `set`
  // trap instead and works correctly, so that's what this test uses,
  // save/restore-style, rather than mock.method.
  test("re-fetching an already-ingested externalEventId (e.g. after a cursor-recovery cold start re-covers the window) creates no duplicate RawProviderEvent or DriverEvent", async () => {
    const EXTERNAL_EVENT_ID = "evt-dup-1";
    const storedRawEventIds = new Set<string>();
    let rawCreateCalls = 0;
    let driverEventCreateCalls = 0;

    function makeEvent(): SamsaraSafetyStreamEvent {
      return {
        id: EXTERNAL_EVENT_ID,
        startMs: "2026-08-01T12:00:00.000Z",
        behaviorLabels: [{ label: "harshBrake" }],
        severity: "medium",
        driver: { id: "111" }, // no driver.name — keeps syncProviderDriverName out of scope for this test
      };
    }

    const original = {
      rawFindUnique: prisma.rawProviderEvent.findUnique,
      rawCreate: prisma.rawProviderEvent.create,
      mappingFindUnique: prisma.driverProviderMapping.findUnique,
      driverEventCreate: prisma.driverEvent.create,
    };

    try {
      (prisma.rawProviderEvent as any).findUnique = async (args: any) => {
        const id = args.where.provider_externalEventId.externalEventId;
        return storedRawEventIds.has(id) ? { id: `raw-${id}` } : null;
      };
      (prisma.rawProviderEvent as any).create = async (args: any) => {
        rawCreateCalls++;
        storedRawEventIds.add(args.data.externalEventId);
        return { id: `raw-${args.data.externalEventId}` };
      };
      (prisma.driverProviderMapping as any).findUnique = async () => ({
        driverId: "drv_1",
        isPilot: true,
        isActive: true,
      });
      (prisma.driverEvent as any).create = async () => {
        driverEventCreateCalls++;
        return {};
      };

      const mappingClient = makeMappingClient(["111"]);

      // Invocation 1: ingests the event fresh.
      const { client: syncStateClient1 } = makeSyncStateClient(null);
      const outcome1 = await runSamsaraSafetyEventsSync(undefined, {
        mappingClient,
        syncStateClient: syncStateClient1,
        fetchPage: async () => ({ data: [makeEvent()], pagination: { endCursor: "c1", hasNextPage: false } }),
      });
      assert.equal(outcome1.synced, true);

      // Invocation 2: simulates the recovery cold-start re-covering the same
      // time window (e.g. right after a parameter-mismatch cursor reset) and
      // re-fetching the SAME event a second time.
      const { client: syncStateClient2 } = makeSyncStateClient(null);
      const outcome2 = await runSamsaraSafetyEventsSync(undefined, {
        mappingClient,
        syncStateClient: syncStateClient2,
        fetchPage: async () => ({ data: [makeEvent()], pagination: { endCursor: "c2", hasNextPage: false } }),
      });
      assert.equal(outcome2.synced, true);

      assert.equal(rawCreateCalls, 1, "RawProviderEvent must be created exactly once across both invocations");
      assert.equal(
        driverEventCreateCalls,
        1,
        "DriverEvent must be created exactly once — the re-fetch must be recognized as a duplicate, never double-ingested"
      );
      if (outcome2.synced && !outcome2.skipped) {
        assert.equal(outcome2.duplicates, 1, "the second invocation's own stats must report the re-fetched event as a duplicate");
      }
    } finally {
      (prisma.rawProviderEvent as any).findUnique = original.rawFindUnique;
      (prisma.rawProviderEvent as any).create = original.rawCreate;
      (prisma.driverProviderMapping as any).findUnique = original.mappingFindUnique;
      (prisma.driverEvent as any).create = original.driverEventCreate;
    }
  });
});

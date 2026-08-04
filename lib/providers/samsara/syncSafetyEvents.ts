/**
 * lib/providers/samsara/syncSafetyEvents.ts
 *
 * Core Samsara Safety Events Stream sync operation, extracted so it can be
 * called two ways:
 *   1. GET /api/sync/samsara-safety-events — CRON_SECRET-authenticated,
 *      kept for manual/ops use now that the 5-minute cron has been removed
 *      (Hobby plan cannot run it reliably).
 *   2. lib/providers/samsara/onDemandSync.ts — called in-process from
 *      /api/risk to refresh stale pilot data before scoring, with no HTTP
 *      round-trip back to our own deployment.
 *
 * Flow:
 *   1. Fetch active pilot driver external IDs → Samsara driverIds pre-filter
 *      (skips API call entirely if no pilot drivers are configured)
 *   2. Load stream cursor + its paired cursorStartTime from ProviderSyncState
 *      (see "Attempts and startTime" below for how the pair is resolved)
 *   3. Drain all pages from Samsara Safety Events Stream, each page:
 *        a. Fetch one page
 *        b. For each event:
 *             i.  normalizeStreamEvent() → NormalizedProviderEvent | null
 *             ii. Dedup via RawProviderEvent.@@unique([provider, externalEventId])
 *                 — same P2002 optimistic strategy as the webhook route
 *             iii.If new: look up DriverProviderMapping, check isPilot + isActive,
 *                 create DriverEvent
 *        c. Persist cursor + cursorStartTime together after each page
 *           (safe checkpoint; re-fetch on crash)
 *   4. Return sync summary
 *
 * Deduplication guarantee:
 *   RawProviderEvent.@@unique([provider, externalEventId]) deduplicates across
 *   ingestion channels. An event delivered by BOTH webhook and stream produces
 *   exactly one RawProviderEvent and one DriverEvent regardless of order. This
 *   is also what makes the same-call cold-start retry (below) safe even when
 *   it re-covers a time range a partially-successful first attempt already
 *   processed — re-fetched events are absorbed as duplicates, never doubled.
 *
 * Attempts and startTime (fixed 2026-07-18, cursor/startTime pairing added
 * 2026-07-18 follow-up):
 *   Samsara's Safety Events Stream requires `startTime` on EVERY request,
 *   including cursor-continuation requests — `after` augments `startTime`,
 *   it does not replace it (see safetyEventsStream.ts's file header for the
 *   full incident writeup). One `startTime` is resolved once per attempt —
 *   never recomputed per page — and reused for every page fetched during
 *   that attempt.
 *
 *   ProviderSyncState.cursorStartTime persists the exact startTime a saved
 *   cursor was established under, so a later invocation can resume with the
 *   *real* pair instead of guessing. Three cases at the start of an attempt:
 *     a. cursor AND cursorStartTime both saved → reuse both exactly ("resume").
 *     b. no cursor saved at all → resolve one fresh cold-start startTime
 *        ("cold-start"). Nothing to protect; there was no prior cursor.
 *     c. cursor saved but cursorStartTime is null (a row written before this
 *        field existed) → the pair is incomplete and cannot be trusted, so
 *        the stored cursor is NOT sent as `after` this attempt ("legacy
 *        recovery"). Per product requirement, the legacy cursor is not
 *        proactively cleared — no explicit reset call is made for it (unlike
 *        the genuine-cursor-error path below). It is simply superseded the
 *        normal way: once a page in this cold-start attempt succeeds, the
 *        per-page checkpoint (3c) writes a fresh, complete cursor/
 *        cursorStartTime pair over it. If the attempt fails before any page
 *        succeeds, the legacy row is untouched and available to retry again.
 *   A same-call retry after a genuine cursor error (see below) always takes
 *   path (b) — a fresh cold start, cursor intentionally dropped.
 *
 * Cursor safety:
 *   Cursor and cursorStartTime are written together, in the same operation,
 *   after each page succeeds — they can never disagree in what's persisted.
 *   A timeout, abort, or DB failure mid-drain causes re-processing of the
 *   current page on the next run; RawProviderEvent dedup absorbs the overlap
 *   without creating duplicate DriverEvents.
 *
 * lastSyncAt semantics:
 *   Unlike cursor, lastSyncAt is stamped exactly once — after the full drain
 *   completes with hasNextPage = false — never per-page. This is what callers
 *   (ensureFreshSamsaraSync) use to decide freshness, so a sync that fails or
 *   times out partway through must NOT advance it: doing so would make an
 *   incomplete drain look fresh to the next request. A successful drain that
 *   finds zero new events still advances it (the sync itself succeeded).
 *
 * Stale-cursor handling (narrowed 2026-07-18, tightened further in the
 * cursor/startTime-pairing follow-up):
 *   Previously, ANY 400/422 from Samsara was treated as an expired cursor —
 *   this misclassified generic validation errors (e.g. the startTime bug
 *   above) as cursor expiry on every multi-page drain, wiping a perfectly
 *   good cursor and abandoning the run with no retry. isCursorSpecificError()
 *   now requires BOTH a cursor/after reference AND explicit invalidity
 *   wording (expired, invalid, stale, no longer valid, not found, unknown) in
 *   Samsara's error message before treating it as a real cursor problem —
 *   messages like "cursor is required" or "cursor format parameter is
 *   missing" reference the cursor but say nothing about it being invalid, so
 *   they're correctly left generic. Generic errors are logged and returned
 *   as a failure WITHOUT touching the saved cursor/cursorStartTime pair, so
 *   the next invocation can still resume from it. A genuine cursor error
 *   clears cursor AND cursorStartTime together and retries exactly once, in
 *   the same invocation, via a fresh cold start — see MAX_SYNC_ATTEMPTS.
 *
 * Cancellation:
 *   An optional AbortSignal can be passed through to the underlying fetch so a
 *   caller (the on-demand path) can enforce a bounded wait. Aborting mid-page
 *   simply surfaces as a failed sync — the cursor from the last completed page
 *   is already persisted, so no data is lost.
 */

import { prisma } from "@/lib/prisma";
import {
  fetchSamsaraSafetyEvents,
  SamsaraApiError,
  type FetchSafetyEventsParams,
} from "@/lib/providers/samsara/safetyEventsStream";
import type { SamsaraSafetyStreamResponse } from "@/lib/providers/samsara/types";
import {
  normalizeSafetyStreamEvent,
  type StreamSkipReason,
} from "@/lib/providers/samsara/normalizeStreamEvent";
import { syncProviderDriverName } from "@/lib/driverIdentity";

export const PROVIDER = "samsara" as const;
export const STREAM_KEY = "safety-events" as const;
const COLD_START_HOURS = 24;

/** Initial attempt + exactly one same-call retry after a genuine cursor-error reset. Prevents infinite loops. */
const MAX_SYNC_ATTEMPTS = 2;

export interface SamsaraSyncStats {
  pagesProcessed: number;
  eventsProcessed: number;
  eventsSkipped: number;
  skipReasons: Record<StreamSkipReason, number>;
  unsupportedLabelsFound: Record<string, number>;
  duplicates: number;
  driverEventsCreated: number;
}

const emptyStats = (): SamsaraSyncStats => ({
  pagesProcessed: 0,
  eventsProcessed: 0,
  eventsSkipped: 0,
  skipReasons: {
    no_driver_id: 0,
    unsupported_behavior_label: 0,
    no_timestamp: 0,
    unexpected_error: 0,
  },
  unsupportedLabelsFound: {},
  duplicates: 0,
  driverEventsCreated: 0,
});

export type SamsaraSyncOutcome =
  | ({ synced: true; skipped: true; reason: "no_pilot_drivers"; elapsedMs: number })
  | ({ synced: true; skipped: false; cursor?: string; elapsedMs: number } & SamsaraSyncStats)
  | ({ synced: false; error: string; elapsedMs: number } & SamsaraSyncStats);

/** Pure — now - COLD_START_HOURS, as an ISO 8601 string. */
function coldStartTime(): string {
  return new Date(Date.now() - COLD_START_HOURS * 60 * 60 * 1000).toISOString();
}

/** A cursor/startTime pair is only trustworthy when both halves are present. */
const CURSOR_REFERENCE_TERMS = ["cursor", "after"];
const CURSOR_INVALIDITY_TERMS = ["expired", "invalid", "stale", "no longer valid", "not found", "unknown"];

/**
 * Samsara's literal wording (confirmed live, 2026-08-04 pagination incident)
 * when a continuation request's parameters don't match the request that
 * minted the cursor — e.g. a differently-ordered `driverIds` string (see
 * Step 1's determinism fix above). This message never mentions "cursor" or
 * "after" by name, so it can't be caught by CURSOR_REFERENCE_TERMS +
 * CURSOR_INVALIDITY_TERMS below — matched by its own narrow, exact phrase
 * instead of loosening that pair (which would risk reclassifying unrelated
 * generic 400s, e.g. "driverIds contains an invalid ID", as cursor errors).
 * It IS a genuine cursor/query-binding failure: the cursor is unusable with
 * any parameter set other than the one it was minted under, so clearing it
 * and retrying via a fresh cold start is the correct, safe recovery — same
 * as any other cursor-specific error.
 */
const CURSOR_PARAMETER_MISMATCH_PHRASE = "parameters differ from previous paginated request";

/**
 * Pure — distinguishes a genuine Samsara cursor/query-binding failure from
 * any other 400/422 (missing params, bad driver IDs, auth, rate limits,
 * etc.). Only the former should ever clear a saved cursor. Samsara does not
 * expose a structured error code for this — we conservatively inspect the
 * `message` field of the JSON error body.
 *
 * Two independent ways a message can qualify:
 *   1. It matches CURSOR_PARAMETER_MISMATCH_PHRASE exactly (see above) — a
 *      confirmed, narrow, real Samsara error string.
 *   2. It references the cursor/after value AND carries explicit invalidity
 *      wording. A message that only references the cursor ("cursor is
 *      required", "cursor format parameter is missing", "request failed
 *      while processing cursor pagination") is NOT enough on its own — those
 *      are generic validation errors that happen to mention the parameter
 *      name, not evidence the cursor itself is bad.
 *
 * Any error that doesn't match either path is treated as generic (fail-safe:
 * prefer keeping a possibly-still-good cursor over wiping one on a false
 * positive).
 */
export function isCursorSpecificError(err: unknown): boolean {
  if (!(err instanceof SamsaraApiError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;

  let message = "";
  try {
    const parsed = JSON.parse(err.responseBody) as { message?: unknown };
    if (typeof parsed?.message === "string") message = parsed.message;
  } catch {
    message = err.responseBody ?? "";
  }

  const lower = message.toLowerCase();

  if (lower.includes(CURSOR_PARAMETER_MISMATCH_PHRASE)) return true;

  const referencesCursor = CURSOR_REFERENCE_TERMS.some((term) => lower.includes(term));
  const indicatesInvalidity = CURSOR_INVALIDITY_TERMS.some((term) => lower.includes(term));
  return referencesCursor && indicatesInvalidity;
}

/** Minimal slice of the Prisma DriverProviderMapping delegate this module needs — narrow enough to fake in tests. */
export interface PilotMappingClient {
  findMany(args: {
    where: { provider: string; isPilot: true; isActive: true };
    select: { externalDriverId: true };
    /** Best-effort hint only — see resolvePilotDriverIds's explicit .sort(), which is the actual determinism guarantee, not this. */
    orderBy?: { externalDriverId: "asc" };
  }): Promise<Array<{ externalDriverId: string }>>;
}

/** Minimal slice of the Prisma ProviderSyncState delegate this module needs — narrow enough to fake in tests. */
export interface SafetyEventsSyncStateClient {
  findUnique(args: {
    where: { provider_streamKey: { provider: string; streamKey: string } };
  }): Promise<{ cursor: string | null; cursorStartTime: Date | null } | null>;
  upsert(args: {
    where: { provider_streamKey: { provider: string; streamKey: string } };
    update: { cursor: string | null; cursorStartTime: Date | null };
    create: { provider: string; streamKey: string; cursor: string | null; cursorStartTime: Date | null };
  }): Promise<unknown>;
  update(args: {
    where: { provider_streamKey: { provider: string; streamKey: string } };
    data: { lastSyncAt: Date };
  }): Promise<unknown>;
}

export interface RunSyncDeps {
  /** Injectable for tests; defaults to the real Samsara HTTP client. */
  fetchPage?: (params: FetchSafetyEventsParams) => Promise<SamsaraSafetyStreamResponse>;
  /** Injectable for tests; defaults to prisma.driverProviderMapping. */
  mappingClient?: PilotMappingClient;
  /** Injectable for tests; defaults to prisma.providerSyncState. */
  syncStateClient?: SafetyEventsSyncStateClient;
}

/**
 * Processes every event on one stream page: dedup, normalize, and (for
 * supported/mapped events) create a DriverEvent. Mutates `stats` in place.
 * Unchanged by the pagination/cursor-pairing fixes — extracted only so the
 * attempt/retry control flow around it stays readable.
 */
async function processPage(page: SamsaraSafetyStreamResponse, stats: SamsaraSyncStats): Promise<void> {
  for (const rawEvent of page.data) {
    stats.eventsProcessed++;

    // externalEventId is always set for stream events (event.id is required by schema)
    const externalEventId = rawEvent.id;

    // Dedup check: optimistic findUnique first, then create with P2002 catch.
    // This now happens BEFORE normalization — the raw payload is preserved
    // regardless of whether normalization later succeeds, so unsupported
    // events remain available for replay once new labels are supported.
    let rawProviderEventId: string | undefined;
    let isDuplicate = false;

    const existing = await prisma.rawProviderEvent.findUnique({
      where: {
        provider_externalEventId: {
          provider: PROVIDER,
          externalEventId,
        },
      },
      select: { id: true },
    });

    if (existing) {
      isDuplicate = true;
      stats.duplicates++;
    } else {
      try {
        const raw = await prisma.rawProviderEvent.create({
          data: {
            provider:        PROVIDER,
            source:          "stream",
            externalEventId,
            rawPayload:      rawEvent as object,
            receivedAt:      new Date(),
          },
          select: { id: true },
        });
        rawProviderEventId = raw.id;
      } catch (createErr: unknown) {
        // P2002 = race between two simultaneous sync invocations (rare but possible)
        if (
          typeof createErr === "object" &&
          createErr !== null &&
          (createErr as { code?: string }).code === "P2002"
        ) {
          isDuplicate = true;
          stats.duplicates++;
        } else {
          console.error(
            `[sync/samsara] Failed to create RawProviderEvent for event id="${rawEvent.id}":`,
            createErr
          );
          continue;
        }
      }
    }

    if (isDuplicate || !rawProviderEventId) continue;

    // Normalize — returns { event: null, skipReason, ... } for unsupported
    // labels, missing driver ID, or missing timestamp. The RawProviderEvent
    // row created above is kept either way.
    const normalized = normalizeSafetyStreamEvent(rawEvent);

    if (!normalized.event) {
      stats.eventsSkipped++;
      const reason = normalized.skipReason ?? "unexpected_error";
      stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1;

      if (reason === "unsupported_behavior_label") {
        for (const label of normalized.observedLabels ?? []) {
          stats.unsupportedLabelsFound[label] =
            (stats.unsupportedLabelsFound[label] ?? 0) + 1;
        }
      }

      // Structured, greppable skip log — no secrets, no full payload.
      console.warn(
        JSON.stringify({
          msg:              "sync_skip",
          reason,
          externalEventId,
          externalDriverId: normalized.externalDriverId ?? rawEvent.driver?.id ?? null,
          timestamp:        rawEvent.startMs ?? rawEvent.createdAtTime ?? null,
          labels:           normalized.observedLabels ?? [],
        })
      );
      continue;
    }

    // Resolve pilot driver mapping and create DriverEvent
    try {
      const mapping = await prisma.driverProviderMapping.findUnique({
        where: {
          provider_externalDriverId: {
            provider:         PROVIDER,
            externalDriverId: normalized.event.externalDriverId,
          },
        },
        select: { driverId: true, isPilot: true, isActive: true },
      });

      if (!mapping) {
        // Should not happen since we pre-filtered by pilot driver IDs, but guard anyway
        console.info(
          `[sync/samsara] No mapping for externalDriverId="${normalized.event.externalDriverId}" — skipping`
        );
        continue;
      }

      // Sync provider-reported driver name onto the mapping + Driver.canonicalName.
      // Independent of pilot/active status below — identity metadata, not event data.
      // Never allowed to break DriverEvent creation.
      if (normalized.event.driverName) {
        try {
          await syncProviderDriverName(
            PROVIDER,
            normalized.event.externalDriverId,
            normalized.event.driverName
          );
        } catch (err) {
          console.error(
            `[sync/samsara] Failed to sync driver name for externalDriverId="${normalized.event.externalDriverId}":`,
            err
          );
        }
      }

      if (!mapping.isActive || !mapping.isPilot) {
        // Mapping may have been deactivated between the prefetch and now
        continue;
      }

      await prisma.driverEvent.create({
        data: {
          driverId:           mapping.driverId,
          rawProviderEventId,
          provider:           PROVIDER,
          externalDriverId:   normalized.event.externalDriverId,
          externalVehicleId:  normalized.event.externalVehicleId ?? null,
          type:               normalized.event.type,
          severity:           normalized.event.severity,
          timestamp:          new Date(normalized.event.timestamp),
          lat:                normalized.event.lat ?? null,
          lng:                normalized.event.lng ?? null,
        },
      });

      stats.driverEventsCreated++;
    } catch (err) {
      // Per-event error: log and continue — do not fail the whole sync run
      console.error(
        `[sync/samsara] Failed to create DriverEvent for event id="${rawEvent.id}":`,
        err
      );
    }
  }
}

/**
 * Runs one full drain of the Samsara Safety Events Stream for active pilot
 * drivers and persists the results. Safe to call directly from server-side
 * code (no HTTP hop, no CRON_SECRET requirement) — auth is the caller's
 * responsibility.
 */
export async function runSamsaraSafetyEventsSync(
  signal?: AbortSignal,
  deps: RunSyncDeps = {}
): Promise<SamsaraSyncOutcome> {
  const startedAt = Date.now();
  const fetchPage = deps.fetchPage ?? fetchSamsaraSafetyEvents;
  const mappingClient =
    deps.mappingClient ?? (prisma.driverProviderMapping as unknown as PilotMappingClient);
  const syncStateClient =
    deps.syncStateClient ?? (prisma.providerSyncState as unknown as SafetyEventsSyncStateClient);

  // ── Step 1: Fetch pilot driver IDs for Samsara-side pre-filtering ─────────
  // Only events for these drivers are fetched — avoids processing the entire fleet.
  //
  // Root cause (2026-08-04 pagination incident): Samsara's stream binds a
  // pagination cursor to the exact literal `driverIds` query string used to
  // mint it — not just startTime. Postgres gives no ordering guarantee for a
  // SELECT without ORDER BY, so this same pilot SET could serialize into a
  // different comma-joined string across two otherwise-identical sync
  // invocations, and Samsara rejects the mismatch with a 400 "Parameters
  // differ from previous paginated request." — confirmed live: resending the
  // exact same stuck cursor+startTime with only the driverIds order swapped
  // flipped the response from 400 to 200. `orderBy` below is a best-effort
  // hint (and self-documenting), but the explicit `.sort()` is the actual
  // guarantee — it makes the final query string deterministic regardless of
  // what order the DB (or a test fake) hands back, which is what
  // buildSafetyEventsStreamUrl actually serializes.
  let pilotDriverIds: string[] = [];
  try {
    const mappings = await mappingClient.findMany({
      where: { provider: PROVIDER, isPilot: true, isActive: true },
      select: { externalDriverId: true },
      orderBy: { externalDriverId: "asc" },
    });
    pilotDriverIds = mappings.map((m) => m.externalDriverId).sort();
  } catch (err) {
    console.error("[sync/samsara] Failed to fetch pilot driver mappings:", err);
    return {
      synced: false,
      error: "Failed to load pilot driver list",
      elapsedMs: Date.now() - startedAt,
      ...emptyStats(),
    };
  }

  if (pilotDriverIds.length === 0) {
    console.info(
      "[sync/samsara] No active pilot drivers configured — skipping sync"
    );
    return {
      synced: true,
      skipped: true,
      reason: "no_pilot_drivers",
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ── Step 2: Load the stream cursor + its paired startTime ────────────────
  // Exactly one of three states results (see the "Attempts and startTime"
  // file header for the full rationale):
  //   - a complete pair (cursor + cursorStartTime)  → "resume"
  //   - nothing saved                                → "cold-start"
  //   - a cursor with no cursorStartTime (legacy row) → "legacy recovery"
  let savedCursor: string | undefined;
  let savedCursorStartTime: string | undefined;
  let isLegacyIncompletePair = false;

  try {
    const state = await syncStateClient.findUnique({
      where: {
        provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
      },
    });
    const cursor = state?.cursor ?? undefined;
    const cursorStartTime = state?.cursorStartTime ?? undefined;

    if (cursor && cursorStartTime) {
      savedCursor = cursor;
      savedCursorStartTime = cursorStartTime.toISOString();
    } else if (cursor && !cursorStartTime) {
      isLegacyIncompletePair = true;
    }
    // else: no cursor saved at all — plain cold start, nothing to carry over.
  } catch (err) {
    console.error("[sync/samsara] Failed to load sync state:", err);
    return {
      synced: false,
      error: "Failed to load sync cursor",
      elapsedMs: Date.now() - startedAt,
      ...emptyStats(),
    };
  }

  // ── Step 3: Drain pages, with one same-call retry on a genuine cursor error ──
  const stats = emptyStats();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const canResumeSavedPair = !isRetry && savedCursor !== undefined && savedCursorStartTime !== undefined;

    // One stable startTime per attempt — resolved once, reused for every
    // page fetched during this attempt (never recomputed per page).
    const startTime = canResumeSavedPair ? savedCursorStartTime! : coldStartTime();
    let currentCursor: string | undefined = canResumeSavedPair ? savedCursor : undefined;
    let lastCursor: string | undefined = currentCursor;

    if (canResumeSavedPair) {
      console.info(`[sync/samsara] Resuming from saved cursor+startTime pair (startTime=${startTime})`);
    } else if (isRetry) {
      console.warn(`[sync/samsara] Retrying with a fresh cold-start bootstrap from ${startTime}`);
    } else if (isLegacyIncompletePair) {
      console.warn(
        `[sync/samsara] Saved cursor has no paired cursorStartTime (pre-migration row) — ` +
          `not resuming it; beginning a bounded cold start from ${startTime} instead. ` +
          `The legacy cursor is left in place until a page in this attempt succeeds.`
      );
    } else {
      console.info(`[sync/samsara] No cursor found — cold-start bootstrap from ${startTime}`);
    }

    try {
      let hasNextPage = true;

      while (hasNextPage) {
        // 3a. Fetch one page — startTime is ALWAYS sent, alongside `after`
        // when continuing (see safetyEventsStream.ts).
        const page = await fetchPage({
          afterCursor: currentCursor,
          startTime,
          driverIds: pilotDriverIds,
          signal,
        });

        stats.pagesProcessed++;
        lastCursor = page.pagination.endCursor;
        hasNextPage = page.pagination.hasNextPage;
        currentCursor = page.pagination.endCursor;

        // 3b. Process each event on this page (unchanged logic)
        await processPage(page, stats);

        // 3c. Persist cursor + its paired startTime together, after each
        // page — safe checkpoint. The pair can never disagree because both
        // halves are written in the same operation. This also naturally
        // supersedes a legacy incomplete-pair row the first time a page in
        // a legacy-recovery attempt succeeds (see file header).
        // lastSyncAt is deliberately NOT touched here: it must only reflect
        // a fully-completed drain (see the stamp after the loop below),
        // otherwise a sync that fails partway through page N would still
        // leave freshness checks (ensureFreshSamsaraSync) seeing a recent
        // timestamp from page N-1's checkpoint and wrongly treating
        // stale/incomplete data as fresh.
        await syncStateClient.upsert({
          where: {
            provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
          },
          update: { cursor: lastCursor ?? null, cursorStartTime: new Date(startTime) },
          create: {
            provider:        PROVIDER,
            streamKey:       STREAM_KEY,
            cursor:          lastCursor ?? null,
            cursorStartTime: new Date(startTime),
          },
        });
      }

      // Drain fully completed (hasNextPage = false) — only now is the sync
      // "fresh". Runs inside this try block so a failure here is treated the
      // same as any other mid-sync failure (falls to the catch below, synced: false).
      // cursor/cursorStartTime are already correct as of the final page's
      // checkpoint above — only lastSyncAt needs stamping here.
      await syncStateClient.update({
        where: {
          provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
        },
        data: { lastSyncAt: new Date() },
      });

      const outcome: SamsaraSyncOutcome = {
        synced: true,
        skipped: false,
        cursor: lastCursor,
        elapsedMs: Date.now() - startedAt,
        ...stats,
      };
      console.info(JSON.stringify({ msg: "sync_complete", ...outcome, attempt }));
      return outcome;
    } catch (err) {
      lastError = err;

      if (isCursorSpecificError(err) && attempt < MAX_SYNC_ATTEMPTS) {
        // Genuine cursor error — clear cursor AND cursorStartTime together
        // and retry once, in this same invocation, via a fresh cold start.
        // MAX_SYNC_ATTEMPTS bounds this to exactly one retry; the loop
        // cannot run away. The new pair is persisted only through the
        // normal successful page-processing path (3c) on the retry.
        console.warn(
          `[sync/samsara] Cursor-specific error on attempt ${attempt} (${(err as SamsaraApiError).status}) — clearing cursor+cursorStartTime and retrying once via cold start.`
        );
        await syncStateClient
          .upsert({
            where: {
              provider_streamKey: { provider: PROVIDER, streamKey: STREAM_KEY },
            },
            update:  { cursor: null, cursorStartTime: null },
            create: { provider: PROVIDER, streamKey: STREAM_KEY, cursor: null, cursorStartTime: null },
          })
          .catch((resetErr: unknown) =>
            console.error("[sync/samsara] Failed to reset cursor:", resetErr)
          );
        continue;
      }

      // Generic error (missing params, bad driver IDs, auth, rate limit,
      // ...) or the retry itself also failed as a cursor error — log and
      // fail WITHOUT touching the saved cursor/cursorStartTime pair.
      // Whatever was checkpointed by the last successful page (or the
      // original stored pair, if page 1 itself failed) remains valid for
      // the next invocation to resume from.
      console.error("[sync/samsara] Sync failed:", err);
      break;
    }
  }

  return {
    synced: false,
    error: lastError instanceof Error ? lastError.message : "Unknown error",
    elapsedMs: Date.now() - startedAt,
    ...stats,
  };
}

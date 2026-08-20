SafeHaul is an AI-driven National Road Safety Risk Prediction System for commercial transportation.

The platform is evolving from a Telegram Mini App MVP into a provider-neutral real-time fleet safety intelligence platform focused on:

* predictive safety scoring;
* explainable risk analysis;
* real-time telematics ingestion;
* operational safety visibility;
* future ML-driven risk prediction.

SafeHaul has successfully transitioned from a prototype using mock safety events to a **Real Data MVP** connected to a live Samsara fleet.

Current development phase:

```txt
Real Data MVP — Controlled Pilot
```

---

# Completed 2026-07-12: On-Demand Samsara Sync

The planned 5-minute Vercel Cron sync was abandoned after discovering the
project runs on the **Vercel Hobby plan**, which cannot run 5-minute crons
reliably. On-demand synchronization was implemented instead:

* Removed the `*/5 * * * *` Samsara cron from `vercel.json` (permanently —
  not paused pending a plan upgrade).
* Extracted the Samsara Safety Events Stream drain loop into a reusable
  server-side service: `lib/providers/samsara/syncSafetyEvents.ts`, callable
  directly from server code with no HTTP hop back to our own deployment.
* Added `lib/providers/samsara/onDemandSync.ts` — `/api/risk` calls
  `ensureFreshSamsaraSync()` for pilot drivers before scoring:
  * Reads `ProviderSyncState.lastSyncAt`; refreshes only if missing or
    older than 5 minutes.
  * Concurrency guard is **database-backed**, not in-memory, since separate
    serverless instances can run simultaneously: an atomic `create()` claims
    the lock (falling back to an atomic `updateMany()` on a `P2002` unique
    -constraint race, mirroring the existing `RawProviderEvent` dedup
    pattern rather than trusting `upsert()`'s internal atomicity).
  * Bounded to a 6-second `AbortController` timeout, chosen to leave
    headroom under Vercel Hobby's ~10s function execution limit.
  * Lock is always released in `finally`.
  * `lastSyncAt` is now stamped exactly once, only after a fully successful
    drain — fixed a bug where a failed/timed-out sync could otherwise leave
    a recent-looking timestamp from a completed page checkpoint, making
    stale data appear fresh.
* Preserved the manual `CRON_SECRET`-protected route
  (`GET /api/sync/samsara-safety-events`) for ops/manual use — it now just
  calls the shared service.
* Structured logs added: `on_demand_sync_decision` (per `/api/risk` call,
  pilot drivers only) and `sync_complete` (kept from the original cron
  implementation).
* Sync statuses are deterministic: `fresh`, `refreshed`, `refresh_failed`,
  `sync_in_progress` — no ambiguous combined states.
* 10 targeted `node:test` cases added
  (`lib/providers/samsara/__tests__/onDemandSync.test.ts`) covering cold
  start, stale state, concurrent cold-start/stale races, timeout, provider
  failure, and zero/nonzero-event successful syncs. Run via `npm test`
  (`tsx` added as a devDependency for this).
* Non-pilot/demo drivers are entirely unaffected — the freshness check and
  sync are skipped for them.

**Deployed to production:** commit `a690a6f` on `main`. Verified in
production: `syncStatus: "refreshed"` and `"fresh"` both observed,
`sync_complete` logs present, no unnecessary Samsara calls while data is
fresh.

Current on-demand architecture:

```txt
Driver
    ↓
Telegram Mini App
    ↓
/api/risk
    ↓
Check ProviderSyncState.lastSyncAt
    ↓
If stale (>5 minutes)
        ↓
Run shared Samsara sync (DB-backed lock + 6s timeout)
        ↓
Update DriverEvents
        ↓
Calculate Risk
        ↓
Return Heads-Up response
```

---

# Completed 2026-07-15: Real HOS and Heads-Up Summary Data

Replaced simulated HOS and Today's Summary values with real data for pilot
drivers, live-validated against the real Samsara pilot account (not just
unit tests):

* **HOS**: `lib/providers/samsara/hos.ts` calls `GET /fleet/hos/clocks`
  (path confirmed live). Exposed via `/api/risk`'s new `hos` object
  (`drivingHoursUsed`/`drivingHoursRemaining`/`shiftHoursUsed`/`status`/
  `source`/`updatedAt`). Unlike speed/zoneRisk, a failed or unresolvable
  pilot fetch yields `value: null, state: "unavailable"` — never a mock
  substitute — so `RiskInput.hosHours` is now `number | null` and the risk
  engine's fatigue penalty is null-aware (`lib/riskEngine.ts`) instead of
  defaulting unknown HOS to a fabricated 0.
* **Checks Passed**: real, from the `Inspection` table
  (`overallResult === "PASS"`, current UTC day) — for every driver, pilot or
  not, since inspections are SafeHaul-native data, not provider-dependent.
* **Miles Driven**: real for pilot drivers, via Samsara **Vehicle Statistics
  History** odometer delta (`lib/providers/samsara/vehicleStats.ts`), not
  Trips. `GET /fleet/trips` and `GET /fleet/vehicles/{id}/trips` were both
  tested live with a valid vehicle ID and the "Read Vehicle Trips"
  permission granted — both returned a plain-text gateway 404, confirming
  neither is a real route in this API generation. Vehicle Stats History
  (`GET /fleet/vehicles/stats/history?types=obdOdometerMeters`) is now
  SafeHaul's canonical mileage source: `data[].obdOdometerMeters` is an
  array of `{time, value}` readings (value in **meters**, time ISO 8601
  `Z`-suffixed); mileage = latest reading − earliest reading in the UTC-day
  window. Pagination is drained (a same-day window returned 340+ readings
  in ~3 hours in testing). A negative delta (odometer rollback) resolves to
  `null`, never a fabricated 0.
* **Alerts Active**: now `result.factors.length` (distinct risk categories
  with a nonzero penalty), replacing a raw safety-event count that didn't
  match the categories shown elsewhere on Heads-Up.
* **Vehicle resolution bug found and worked around**: the pilot's
  `DriverProviderMapping.externalVehicleId` was seeded with the vehicle's
  **display name**, not its Samsara ID (discovered when a live Vehicle
  Stats call returned a structured 400 "Invalid ID format"). `lib/todaySummary.ts`
  now treats a non-numeric `externalVehicleId` as missing and falls through
  to the most recent `DriverEvent.externalVehicleId` — this is a defensive
  workaround, not a fix to the underlying row (see follow-ups below).
* All new Samsara calls are timeout-bounded (`AbortController`) and
  non-fatal — one unavailable provider call never breaks the rest of
  `/api/risk`.

**Deployed:** commit `8f44b12` on `main`.

## Follow-ups (not yet done)

1. **Validate HOS entry-level fields for real.** The pilot driver had no
   active HOS clock at validation time (`GET /fleet/hos/clocks` returned
   `data: []`) — the endpoint path and envelope shape are confirmed, but
   entry fields (`clocks.drive.durationMsRemaining`,
   `clocks.shift.durationMsElapsed`, `lastUpdatedAtTime`) in
   `lib/providers/samsara/hos.ts` are still unvalidated guesses. Re-run
   validation once the pilot driver has an active clock.
2. **Correct the invalid `externalVehicleId` seed data at its source** —
   the code-level workaround above should not be the permanent fix; the
   `DriverProviderMapping` row itself should be corrected to hold the real
   Samsara vehicle ID.
3. **Visually verify the Heads-Up mobile layout** in Telegram or a real
   browser — this phase's UI correctness was verified by tracing real
   `/api/risk` responses against the rendering logic, not by screenshot (no
   browser-automation tool was available in that session).

---

# Completed 2026-08-12: Phase 6B — Hybrid Pilot Observation Architecture

Added a second, complementary historical record alongside `DriverEvent`
("what happened"): `DriverObservation` ("what conditions existed at a
point in time") — periodic baseline snapshots plus best-effort
event-triggered context, for pilot drivers. Delivered incrementally as six
sub-phases, each independently committed, validated against the real
pilot fleet, and pushed to `main`:

* **6B.1 — Schema.** New `DriverObservation` model: `triggerType`
  (`"interval"` | `"safety_event"`), optional `driverEventId` (nullable
  FK — Postgres treats multiple `NULL`s as non-conflicting under a unique
  index, verified live), `observedAt`/`collectedAt` as two deliberately
  separate timestamps, scalar projections
  (`latitude`/`longitude`/`speedMph`/`hosShiftHoursUsed`/`weatherRisk`/`zoneRisk`)
  for cheap querying, and a `contextJson` blob that reuses the *existing*
  `VehicleLocation`/`WeatherDetail`/`HosDetail`/`ZoneDetail` provenance
  types verbatim rather than inventing new provenance columns. RLS enabled
  to match every other permanent domain table. Commit `d8aa198`.
* **6B.2 — Collector.** `lib/driverContext/captureObservation.ts`:
  `buildDriverObservationSnapshot()` / `captureDriverObservation()` /
  `persistDriverObservationSnapshot()`, built by reusing the *same*
  `assembleLocation`/`assembleWeather`/`assembleZoneRisk`/`assembleHos`/
  `assembleSpeed` functions `/api/risk` already uses — no duplicate
  provider clients. `observedAt`/`collectedAt` are always the collection
  instant, never `DriverEvent.timestamp`. Manual dry-run/`--apply` CLI at
  `scripts/captureDriverObservation.ts`. Commit `29b44c6`.
* **6B.3 — Baseline scheduler (manual).** `GET /api/sync/driver-observations`
  (`CRON_SECRET`-gated): one `triggerType: "interval"` capture per active
  pilot driver, gated on (a) a 10-minute recency guard
  (`BASELINE_INTERVAL_MS`, checked *before* any provider call) and (b) a
  fresh-location requirement (stale/unavailable GPS → skipped, never
  persisted with nulled fields). Commit `e8c8e0b`.
* **6B.4 — Safety Event-triggered enrichment.** `syncSafetyEvents.ts` now
  tracks `newDriverEventIds` (genuinely new rows only) and, strictly
  *after* a successful drain, attempts one best-effort
  `triggerType: "safety_event"` observation per new event via
  `lib/driverContext/eventEnrichment.ts::enrichNewDriverEvents()` — reusing
  the same 6B.2 collector, unconditionally (no location-freshness gate,
  unlike baseline: event provenance is still useful even with a stale
  current position). Enrichment failure never fails Safety Event
  ingestion. Commit `91114d2`.
* **6B.5 — Concurrency hardening.** Two gaps closed: (1)
  `/api/sync/samsara-safety-events` used to call the sync function directly,
  bypassing the on-demand path's DB lock — both now share one lock
  (`lib/providers/samsara/syncLock.ts`). (2) Added
  `@@unique([driverEventId, triggerType])` on `DriverObservation` (verified
  live: existing `NULL`-`driverEventId` interval rows unaffected, a real
  duplicate insert correctly rejected with `P2002`) and updated enrichment
  to treat that specific race as `already_enriched`, not a failure — the DB
  constraint, not the pre-check `findFirst`, is the actual source of truth.
  Commit `3953a3d`.
* **6B.6 — Combined cycle.** `lib/providerSyncLock.ts` generalizes the
  Phase 6B.5 lock to any `(provider, streamKey)` pair (Safety Events lock
  now a thin wrapper over it). `lib/driverContext/pilotObservationCycle.ts::
  runPilotObservationCycle()`: a job-level lock
  (`samsara`/`pilot-observation-cycle`, a separate row from the Safety
  Events lock — two independent, non-blocking locks, so no deadlock is
  possible) wraps Safety Events sync (via the shared lock) followed by
  baseline collection, always attempted regardless of whether Safety
  Events synced, was busy, or failed. Exposed at
  `GET /api/sync/pilot-observation-cycle`. Commit `5ff2e2d`.

**Scheduling: enabled as of Phase 6C (2026-08-20), via Supabase Cron —
not Vercel Cron.** `vercel.json` remains untouched (still only the
pre-existing daily `/api/inspect/cleanup` entry); the Hobby-plan
sub-daily-cron limitation described in CLAUDE.md is sidestepped entirely
by scheduling outside Vercel. See "Completed 2026-08-20: Phase 6C" below
for full detail. The two individual routes
(`/api/sync/samsara-safety-events`, `/api/sync/driver-observations`)
remain manual/ops-only (`CRON_SECRET`) and are deliberately **not**
scheduled independently — only the combined
`/api/sync/pilot-observation-cycle` is.

Combined architecture (once/if a scheduler is ever enabled, this is the
only job that should be scheduled — not the two individual routes):

```txt
GET /api/sync/pilot-observation-cycle  [CRON_SECRET]
        ↓
withProviderSyncLock (job lock: samsara/pilot-observation-cycle)
        ↓
withSamsaraSyncLock (SAME shared lock /api/risk's on-demand path uses:
                      samsara/safety-events)
        ↓
runSamsaraSafetyEventsSync → RawProviderEvent → DriverEvent
        ↓
enrichNewDriverEvents → DriverObservation(triggerType="safety_event")
        ↓
runBaselineObservationSync (10-min BASELINE_INTERVAL_MS guard,
                             fresh-location gate)
        ↓
DriverObservation(triggerType="interval")
```

**What Phase 6B does NOT provide yet:** `RiskScoreHistory`, historical
score trends, and incident-to-score linkage are not implemented —
`ComplianceScore` remains the same coarse once-per-UTC-day snapshot it was
before Phase 6B. XGBoost has not been started. Event-triggered
`DriverObservation` rows represent *discovery-time* context
(`observedAt`/`collectedAt`), never claimed to be event-time context — only
`DriverEvent.timestamp`/`lat`/`lng` represent the actual moment of the
event. Live-validated: `hosShiftHoursUsed` is currently `null` on every
real captured row (this pilot driver has no active Samsara HOS clock) —
correctly represented as unavailable, never fabricated.

Git checkpoints:

```txt
d8aa198  feat: add driver observation schema (6B.1)
29b44c6  feat: add driver observation collector (6B.2)
e8c8e0b  feat: add manual baseline observation sync (6B.3)
91114d2  feat: capture context for new safety events (6B.4)
3953a3d  fix: harden observation sync concurrency (6B.5)
5ff2e2d  feat: add hybrid pilot observation cycle (6B.6)
```

---

# Completed 2026-08-20: Phase 6C — Automatic Hybrid Pilot Collection (Supabase Cron)

Connected the already-built, already-tested Phase 6B.6 endpoint to a real
scheduler. No application code changed — this was infrastructure only
(Postgres extensions, Vault secrets, one `cron.job` row) against the same
production Supabase project this app already uses.

* **Production URL verified first, not assumed.** The Vercel MCP
  integration's linked account only exposes an unrelated `baraka-market`
  project (same gap noted in Phase 6B), so the host was instead confirmed
  via GitHub's Deployments API (the latest deployment record for commit
  `5ff2e2d` resolves to `https://safehaul.vercel.app`) and live HTTP
  checks: `/` returns the real SafeHaul app, and
  `GET /api/sync/pilot-observation-cycle` without auth returns `401` as
  expected. The auto-generated team-scoped alias
  (`safehaul-*-vercel.app`) redirects to Vercel SSO login and is **not**
  usable by `pg_net` — `safehaul.vercel.app` is the correct target.
* **Extensions enabled** on the production Supabase Postgres instance:
  `pg_cron` 1.6.4, `pg_net` 0.20.0 (both were available but not yet
  installed). `supabase_vault` 0.3.1 was already installed.
* **Secrets in Vault, not SQL.** `vault.create_secret()` stores
  `safehaul_cron_secret` (the app's existing `CRON_SECRET` — not rotated)
  and `safehaul_production_base_url`. The cron job's SQL body reads both
  via `vault.decrypted_secrets` at execution time; neither value is
  hardcoded in the job definition.
* **One job, one target.** `cron.schedule('safehaul-pilot-observation-cycle',
  '*/10 * * * *', ...)` → `net.http_get()` against
  `GET /api/sync/pilot-observation-cycle` with
  `Authorization: Bearer <CRON_SECRET>`, `timeout_milliseconds := 55000`,
  no retry logic (relies on pg_cron's normal next-tick behavior — the
  route's own DB-backed locks and graceful failure handling from Phase 6B
  are unchanged and still the sole concurrency mechanism). The two
  individual sync routes were deliberately **not** scheduled.
* **Validated end-to-end against production**, not simulated: one real
  invocation surfaced 22 genuinely new `DriverEvent` rows (all
  successfully enriched) and created 2 baseline `DriverObservation` rows
  (the 2 active pilot drivers, both due). An immediate second invocation
  correctly no-opped (`recent_observation` skip, 0 new driver events).
  The exact stored cron command was then executed directly (pg_cron has
  no SQL "run now"; this is what Supabase Dashboard's manual trigger
  ultimately does) and `net._http_response` recorded `status_code: 200`
  with the same idempotent result — proving the scheduler path
  (Vault → `net.http_get` → production route) behaves identically to the
  manually-tested Phase 6B.6 path, not just adjacent to it.
* **Observability** without a new dashboard: `cron.job_run_details` (pg_cron's
  run history), `net._http_response` (HTTP status/body/error per
  invocation), `"ProviderSyncState".lastSyncAt`/`syncLockedAt` (is it
  running / is it stuck), and `"DriverObservation".collectedAt` (data-level
  confirmation) are all queryable directly against the existing
  production database.

No repository files changed in this phase (infrastructure only — see
"Git status" note: `project_context.md` is the only tracked file
modified, to document this work).

---

# Current Tech Stack

Frontend:

* Next.js 14 App Router
* TypeScript
* Tailwind CSS
* Telegram WebApp SDK

Backend:

* Next.js API Routes
* Prisma ORM
* PostgreSQL (Supabase)
* Supabase Storage

External integrations:

* Samsara (webhook ingestion + on-demand Safety Events Stream sync)
* Anthropic Claude API (inspection analysis)
* OpenWeather API

Deployment:

* Vercel

---

# Current Application Structure

Frontend screens:

* Dashboard
* Inspect
* Audit
* DrivingOverlay

Main app flow:

```txt
Telegram WebApp
      ↓
app/page.tsx
      ↓
Tab-based navigation
      ↓
Dashboard / Inspect / Audit
```

Backend architecture:

```txt
Frontend
    ↓
Next.js API Routes
    ↓
service/helper layer
    ↓
Prisma
    ↓
PostgreSQL / Supabase
```

---

# Current Working Features

## Dashboard

Current functionality:

* real-time risk scoring;
* explainable risk factors;
* recommendations;
* operational context;
* hybrid mock/live risk flow.

Current risk engine:

* rule-based;
* explainable;
* modular;
* ML-ready for future XGBoost migration.

---

## Inspect

AI-powered inspection system.

Current features:

* photo upload;
* image compression;
* Supabase Storage integration;
* Claude Haiku analysis;
* structured inspection results;
* signed image URLs;
* 30-day photo retention cleanup.

---

## Audit

Unified operational audit trail.

Current event sources:

* incidents;
* inspections;
* trips;
* compliance scores;
* safety events;
* DriverEvents (real Samsara stream events — Phase 5B).

DriverEvents appear with:

* title: human-readable type label (e.g. "Mobile Usage", "Harsh Braking")
* badge: severity-based (NOTICE / WARNING / HIGH ALERT)
* detail: "Detected by Samsara onboard telematics."
* meta: provider + channel (e.g. `Samsara · Stream`), severity, GPS flag

Audit events are persisted historically and sorted by timestamp.

---

# Current Database Models

Core models:

* Company
* Driver
* DriverProviderMapping
* ProviderAccount
* Trip
* SafetyEvent
* DriverEvent
* DriverObservation (Phase 6B — periodic/event-triggered context snapshots, distinct from DriverEvent)
* RawProviderEvent
* ProviderSyncState (cursor + sync/job locks, keyed by provider+streamKey)
* WebhookLog
* ComplianceScore
* Incident
* Inspection

Current provider identity flow:

```txt
Telegram User
      ↓
Driver
      ↓
DriverProviderMapping
      ↓
External Provider Identity
```

DriverProviderMapping currently controls:

* pilot-driver isolation;
* provider linking;
* external driver mapping;
* active/inactive provider relationships.

---

# Current Real-Time Event Pipeline

SafeHaul now supports real webhook ingestion architecture.

Current flow:

```txt
Samsara Webhook
        ↓
Signature Verification
        ↓
WebhookLog
        ↓
RawProviderEvent
        ↓
normalizeEvent()
        ↓
DriverEvent
        ↓
Pilot Filtering
        ↓
Risk Engine
        ↓
ComplianceScore
```

---

# Current Supported DriverEvent Types

Normalized provider-neutral event types:

* harsh_accel
* harsh_braking
* harsh_turn
* high_speed_power_loss
* inattentive_driving
* mobile_usage

Unknown provider events:

* ignored safely;
* logged;
* preserved in raw payload storage.

---

# Current Risk Flow

## Pilot Drivers

Pilot drivers use REAL DriverEvent rows, refreshed on-demand when stale
(2026-07-12 — see "Completed 2026-07-12" above):

```txt
ensureFreshSamsaraSync() [if lastSyncAt >5min old]
      ↓
DriverEvent DB rows
      ↓
Risk Engine
```

**Caveat — `dataSource: "real"` still overstates truthfulness, though less
than before 2026-07-15.** Safety events and HOS are now truly live for
pilot drivers (see "Completed 2026-07-15" above). Speed and zone risk are
still mock inputs even for pilot drivers. See "Current Technical Debt" →
"Data Truthfulness" below.

## Non-Pilot Drivers

Non-pilot drivers still use mock scenarios:

```txt
Mock Scenario
      ↓
Risk Engine
```

Mock infrastructure intentionally remains enabled during pilot rollout.

Current `/api/risk` response includes:

```txt
dataSource: "real" | "mock"
```

---

# Current Samsara Integration Status

Implemented:

* webhook ingestion endpoint;
* HMAC signature verification;
* timestamp validation;
* timing-safe comparison;
* replay-window protection;
* webhook deduplication/idempotency;
* normalized DriverEvent pipeline;
* pilot-driver filtering;
* hybrid real/mock risk engine integration;
* Safety Events Stream polling (Phase 5A — see below);
* hybrid pilot observation cycle — Safety Events sync + event-triggered and
  baseline `DriverObservation` capture (Phase 6B — see "Completed
  2026-08-12" above);
* automatic scheduling of the hybrid cycle every 10 minutes via Supabase
  Cron (`pg_cron`/`pg_net`/Vault) — not Vercel Cron (Phase 6C — see
  "Completed 2026-08-20" above).

Not yet implemented:

* live GPS streaming;
* admin UI for mappings;
* queue/dead-letter system;
* structured observability;
* realtime socket infrastructure.

---

# Phase 5A → 5D: Safety Events Stream Sync (now On-Demand)

## Status: VALIDATED ✓ (2026-06-04), sync trigger superseded 2026-07-12

The underlying Samsara Safety Events Stream integration (endpoint, payload
parsing, dedup) was fully validated on 2026-06-04 (see below) and is
unchanged. What changed on 2026-07-12 is **how the sync is triggered**: the
planned `*/5 * * * *` Vercel Cron was abandoned (Hobby plan cannot run it
reliably) in favor of on-demand sync from `/api/risk` — see the "Completed
2026-07-12" section above for the full design. The cron entry has been
**removed from `vercel.json`**, not merely paused.

Original three validation gates (still true, now historical):
1. `SAMSARA_API_TOKEN` configured and verified ✓
2. Manual sync returned HTTP 200 with real Samsara data ✓
3. First real DriverEvents created from stream data ✓ (3 × mobile_usage for driver 53142293)

## Purpose

The Samsara Safety Events Stream API (`GET /safety-events/stream`) is the
authoritative source for harsh_braking, mobile_usage, inattentive_driving, and
harsh_turn events.

## Architecture (current — on-demand, DB-lock guarded)

```txt
/api/risk (pilot driver)                 GET /api/sync/samsara-safety-events
        ↓                                  [CRON_SECRET auth, manual/ops use]
ensureFreshSamsaraSync()                            ↓
[DB lock via ProviderSyncState.syncLockedAt]         ↓
        ↓                                            ↓
        └──────────────→ runSamsaraSafetyEventsSync() ←──────────────┘
                    (lib/providers/samsara/syncSafetyEvents.ts)
                                 ↓
                    Fetch pilot driver IDs from DriverProviderMapping
                                 ↓
                    fetchSamsaraSafetyEvents(afterCursor?, driverIds[], signal?)
                                 ↓
                    Loop until hasNextPage = false:
                                 ↓
                    normalizeSafetyStreamEvent(event) → NormalizedProviderEvent | null
                                 ↓
                    RawProviderEvent (source="stream", dedup via externalEventId)
                                 ↓
                    DriverProviderMapping lookup + isPilot check
                                 ↓
                    DriverEvent
                                 ↓
                    ProviderSyncState cursor update per page;
                    lastSyncAt stamped once, only on full success
```

## Key properties

* Event deduplication: `RawProviderEvent.@@unique([provider, externalEventId])`
  absorbs events arriving via BOTH webhook and stream — only one DriverEvent is
  ever created per Samsara event ID.

* `source` field on `RawProviderEvent`: `"webhook"` or `"stream"` — distinguishes
  ingestion channel for observability.

* `ProviderSyncState`: generic cursor table keyed by `(provider, streamKey)`.
  Future providers (Motive, Geotab) share this table.

* Pilot pre-filtering: pilot driver external IDs are passed as `driverIds[]` to
  the Samsara API — only pilot events are fetched from the stream.

* Stale cursor recovery: on Samsara 4xx for expired cursor, cursor is cleared and
  the next sync run (on-demand or manual) bootstraps from the last 24 hours.

* `ProviderSyncState.syncLockedAt`: DB-backed concurrency guard for the
  on-demand path — see "Completed 2026-07-12" above.

## Environment variables — current status

Both are configured. Validation complete.

### SAMSARA_API_TOKEN

**Configured locally (.env.local) and verified against real Samsara org.**
**Confirmed present in Vercel Environment Variables (production deploy uses it).**

Token requires **Read Safety Events & Scores** permission (Safety & Cameras
category).

### CRON_SECRET

**Configured locally (.env.local) and in Vercel Environment Variables.**
Still required — it protects the manual `GET /api/sync/samsara-safety-events`
route, which remains available for ops/manual use even though nothing calls
it on a schedule anymore.

---

## Validated Samsara stream payload fields (2026-06-04)

Real Samsara Safety Events Stream events use these field names (different from docs):

* Timestamp: `startMs` — an ISO 8601 string (NOT milliseconds, despite the name)
* Fallback timestamp: `createdAtTime` (also ISO 8601)
* Vehicle/asset: `asset.id` — NOT `vehicle.id`
* Driver: `driver.id` — correct
* Behavior labels: `behaviorLabels[].label` — PascalCase (e.g. `"MobileUsage"`)
* Severity: absent on mobile_usage events (defaults to 3)
* Location: `location.latitude` / `location.longitude` — correct

These are verified against 3 real MobileUsage events for driver 53142293.

---

## Cron entry — superseded, do not restore (2026-07-12)

The three validation gates cleared on 2026-06-04, and this cron entry was
briefly considered ready to restore — but on 2026-07-12 the plan changed:
the project runs on **Vercel Hobby**, which cannot run this schedule
reliably, so the cron approach was replaced with on-demand sync instead.
**Do not re-add this to `vercel.json`:**

```json
{
  "crons": [
    {
      "path": "/api/sync/samsara-safety-events",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

**Decision: no cron, ever, on the current plan.** The `*/5 * * * *` schedule
requires Vercel Pro; rather than wait on a plan upgrade, the sync trigger was
redesigned to be on-demand (see "Completed 2026-07-12" above). Revisit this
decision only if/when the project moves to Pro and a scheduled background
refresh becomes worth reintroducing alongside (not instead of) on-demand sync.

## Files (Phase 5A baseline + 2026-07-12 on-demand additions)

```
lib/providers/samsara/safetyEventsStream.ts    — HTTP client (+ AbortSignal support, 2026-07-12)
lib/providers/samsara/normalizeStreamEvent.ts  — stream-specific normalizer
lib/providers/samsara/syncSafetyEvents.ts      — NEW 2026-07-12: extracted, reusable sync operation
lib/providers/samsara/onDemandSync.ts          — NEW 2026-07-12: freshness check + DB lock + timeout
lib/providers/samsara/__tests__/onDemandSync.test.ts — NEW 2026-07-12: 10 node:test cases
app/api/sync/samsara-safety-events/route.ts    — thinned 2026-07-12: now just auth + call shared service
app/api/risk/route.ts                          — 2026-07-12: calls ensureFreshSamsaraSync() for pilot drivers
prisma/schema.prisma                           — ProviderSyncState model; source field on RawProviderEvent;
                                                  syncLockedAt added 2026-07-12
lib/providers/samsara/normalizeEvent.ts        — exported SAMSARA_TYPE_MAP and normalizeSeverity
lib/providers/samsara/types.ts                 — SamsaraBehaviorLabel, SamsaraSafetyStreamEvent, SamsaraSafetyStreamResponse
vercel.json                                    — Samsara cron entry removed 2026-07-12 (permanent, see above)
package.json                                   — added `test` script and `tsx` devDependency, 2026-07-12
```

Git checkpoints:

```txt
0dd814c  fix: support real Samsara safety event labels (Phase 5A baseline)
a690a6f  feat: add on-demand Samsara sync with database lock (2026-07-12)
```

---

# Current Security Posture

Current security architecture:

* all integrations server-side only;
* no provider secrets exposed to frontend;
* webhook signatures verified;
* stale timestamps rejected;
* idempotency enforced;
* telemetry treated as sensitive operational data.

Important env vars:

* SAMSARA_API_TOKEN
* SAMSARA_WEBHOOK_SECRET
* SUPABASE_SERVICE_ROLE_KEY
* OPENWEATHER_API_KEY

Current database access:

```txt
Prisma + Supabase service-role
```

RLS is enabled/recommended for telemetry tables.

---

# Current Technical Debt

## Data Truthfulness (top priority — see "Next Development Priority" below)

1. ~~Pilot drivers still use mock HOS.~~ Real as of 2026-07-15 (see
   "Completed 2026-07-15") — entry-level HOS fields remain unvalidated,
   though (follow-up #1 below).
2. Pilot drivers still use mock speed.
3. Pilot drivers still use mock zone risk.
4. Weather falls back to mock if unavailable.
5. `dataSource` currently overstates "real" because speed/zone risk still
   aren't sourced from a real provider, even though safety events and HOS
   now are.
6. Three `DriverEvent` types remain unscored by the risk engine:
   * `rolling_stop`
   * `following_distance`
   * `forward_collision_warning`
7. `ComplianceScore` historical persistence still requires redesign.

## Follow-ups from 2026-07-15 (Real HOS / Heads-Up Summary)

8. Validate HOS entry-level fields (`clocks.drive`/`clocks.shift`,
   `lastUpdatedAtTime`) against a real payload — the pilot driver had no
   active clock during validation, so these remain unconfirmed guesses in
   `lib/providers/samsara/hos.ts`.
9. Correct the invalid `externalVehicleId` seed data at its source — the
   pilot's `DriverProviderMapping` row holds the vehicle's display name
   instead of its Samsara ID. `lib/todaySummary.ts` works around this
   defensively but the row itself should be fixed.
10. Visually verify the Heads-Up mobile layout in Telegram or a real
    browser — not yet done with a screenshot/browser tool.

## High Priority

* Telegram initData is not server-verified yet
* No API authentication middleware
* Multi-tenant architecture incomplete
* No structured observability/log aggregation
* No queue/dead-letter webhook handling

## Medium Priority

* Audit pagination not implemented
* Dashboard still polling-based
* Risk trend logic still placeholder
* No admin UI for provider mappings

## Low Priority

* Some Samsara payload assumptions still marked TODO

---

# Recent Major Milestones

## AI Inspection System

Completed:

* photo upload;
* Claude Haiku inspection analysis;
* Supabase Storage integration;
* audit integration;
* 30-day retention cleanup.

Git checkpoint:

```txt
1c33ca4
```

---

## Samsara Webhook Ingestion Pipeline

Completed:

* secure webhook endpoint;
* verification layer;
* normalization layer;
* RawProviderEvent persistence;
* DriverEvent persistence;
* pilot-driver filtering.

Git checkpoint:

```txt
c9dbb5d
35c16cc
```

---

## Real DriverEvent Risk Integration

Completed:

* DriverEvent → risk engine flow;
* hybrid real/mock architecture;
* pilot-driver real scoring;
* new risk penalty mappings.

Git checkpoint:

```txt
bd1d62a
```

---

## On-Demand Samsara Sync (2026-07-12)

Completed — see "Completed 2026-07-12: On-Demand Samsara Sync" above for full detail.

Git checkpoint:

```txt
a690a6f
```

---

## Hybrid Pilot Observation Architecture (2026-08-12)

Completed — see "Completed 2026-08-12: Phase 6B — Hybrid Pilot Observation
Architecture" above for full detail. Six sub-phases (schema, collector,
manual baseline route, Safety Event enrichment, concurrency hardening,
combined cycle); scheduling intentionally not enabled at the time.

Git checkpoints:

```txt
d8aa198
29b44c6
e8c8e0b
91114d2
3953a3d
5ff2e2d
```

---

## Automatic Hybrid Pilot Collection (2026-08-20)

Completed — see "Completed 2026-08-20: Phase 6C — Automatic Hybrid Pilot
Collection (Supabase Cron)" above for full detail. Infrastructure-only:
enabled `pg_cron`/`pg_net` on the production Supabase Postgres instance,
stored `CRON_SECRET` and the production base URL in Supabase Vault, and
created one `cron.job` (`safehaul-pilot-observation-cycle`, every 10
minutes) that calls `GET /api/sync/pilot-observation-cycle`. No repository
code changed; `vercel.json` untouched. No git checkpoint — nothing was
committed to the application codebase for this phase.

---

# Next Development Priority

**The next session should NOT focus on UI improvements or machine learning.**

Highest priority: make the risk engine fully truthful by replacing remaining
mock inputs for pilot drivers with real provider data (or clearly labeling
partial-real inputs), so the displayed score accurately reflects its
underlying data sources. See "Current Technical Debt" → "Data Truthfulness"
above for the specific list to work through.

Do not remove support for mock/demo drivers while doing this — SafeHaul must
continue supporting both real pilot drivers and demo drivers, and the
architecture must stay provider-neutral so additional telematics providers
can be integrated later.

---

# Other Development Priorities (lower precedence than the above)

Immediate priorities:

1. Real Samsara payload validation for HOS/speed/zone data sources (feeds the truthfulness priority above)
2. Pilot-driver operational testing
3. Audio alert system
4. Live dashboard event integration refinements

Mid-term priorities:

* realtime infrastructure;
* advanced risk logic;
* admin tooling;
* analytics;
* multi-tenant architecture.

Long-term priorities:

* ML/XGBoost risk scoring
* predictive analytics
* fleet intelligence platform
* operational optimization
* safety benchmarking

---

# Current Development Rules

* Keep provider-specific logic isolated:

```txt
lib/providers/{provider}/
```

* Avoid business logic inside route handlers.
* Preserve replay/debug capability.
* Store raw provider payloads whenever practical.
* Maintain provider-neutral schemas.
* Prefer modular architecture over quick shortcuts.
* Think about retries, stale telemetry, deduplication, replay attacks, and scaling during implementation.

---

# Current Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
npm test

npx prisma generate
npx prisma db push
npx prisma studio
```

`npm test` runs `tsx --test "lib/**/__tests__/**/*.test.ts"` (Node's built-in
test runner via `tsx`, added 2026-07-12 for the on-demand sync tests — no
other test framework is configured).

Current workflow still uses:

```txt
prisma db push
```

Migration-based workflow should be adopted before broader production rollout.

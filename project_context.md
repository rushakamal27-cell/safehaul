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
* RawProviderEvent
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

**Caveat — `dataSource: "real"` currently overstates truthfulness.** Only
safety events (harsh_braking, mobile_usage, etc.) are truly live for pilot
drivers. HOS, speed, and zone risk are still mock inputs even for pilot
drivers. See "Current Technical Debt" → "Data Truthfulness" below — this is
the top priority for the next session.

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
* Safety Events Stream polling (Phase 5A — see below).

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

1. Pilot drivers still use mock HOS.
2. Pilot drivers still use mock speed.
3. Pilot drivers still use mock zone risk.
4. Weather falls back to mock if unavailable.
5. `dataSource` currently overstates "real" because only safety events are truly live.
6. Three `DriverEvent` types remain unscored by the risk engine:
   * `rolling_stop`
   * `following_distance`
   * `forward_collision_warning`
7. `ComplianceScore` historical persistence still requires redesign.

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

SafeHaul is an AI-driven National Road Safety Risk Prediction System for commercial transportation.

The platform is evolving from a Telegram Mini App MVP into a provider-neutral real-time fleet safety intelligence platform focused on:

* predictive safety scoring;
* explainable risk analysis;
* real-time telematics ingestion;
* operational safety visibility;
* future ML-driven risk prediction.

Current development phase:

```txt
Controlled Real-Data Pilot
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

* Samsara (webhook ingestion in progress)
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
* DriverEvents.

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

Pilot drivers now use REAL DriverEvent rows:

```txt
DriverEvent DB rows
      ↓
Risk Engine
```

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

# Phase 5A: Safety Events Stream Sync

## Status: VALIDATED ✓ (2026-06-04)

All three gates passed:
1. `SAMSARA_API_TOKEN` configured and verified ✓
2. Manual sync returned HTTP 200 with real Samsara data ✓
3. First real DriverEvents created from stream data ✓ (3 × mobile_usage for driver 53142293)

Cron entry may now be re-added to `vercel.json` (requires Vercel Pro plan).

## Purpose

The Samsara Safety Events Stream API (`GET /safety-events/stream`) is the
authoritative source for harsh_braking, mobile_usage, inattentive_driving, and
harsh_turn events. Phase 5A adds a cron-triggered poller alongside the existing
webhook pipeline.

## Architecture

```txt
Vercel Cron (*/5 * * * *)
        ↓
GET /api/sync/samsara-safety-events
[CRON_SECRET auth]
        ↓
Fetch pilot driver IDs from DriverProviderMapping
        ↓
fetchSamsaraSafetyEvents(afterCursor?, driverIds[])
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
ProviderSyncState cursor update
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
  the next cron run bootstraps from the last 24 hours.

## Environment variables — current status

Both are configured. Validation complete.

### SAMSARA_API_TOKEN

**Configured locally (.env.local) and verified against real Samsara org.**

Token requires **Read Safety Events & Scores** permission (Safety & Cameras
category). Must also be added to Vercel Environment Variables for deployment.

### CRON_SECRET

**Configured locally (.env.local).** Must also be added to Vercel Environment
Variables. Vercel Cron injects it automatically as `Authorization: Bearer
$CRON_SECRET` once the cron entry is restored.

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

## Cron entry — ready to restore

All three gates have cleared. Re-add to `vercel.json`:

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

Requires Vercel Pro plan for `*/5 * * * *` frequency.

## New files

```
lib/providers/samsara/safetyEventsStream.ts   — HTTP client
lib/providers/samsara/normalizeStreamEvent.ts  — stream-specific normalizer
app/api/sync/samsara-safety-events/route.ts    — sync endpoint
```

## Modified files

```
prisma/schema.prisma                           — ProviderSyncState model; source field on RawProviderEvent
lib/providers/samsara/normalizeEvent.ts        — exported SAMSARA_TYPE_MAP and normalizeSeverity
lib/providers/samsara/types.ts                 — SamsaraBehaviorLabel, SamsaraSafetyStreamEvent, SamsaraSafetyStreamResponse
vercel.json                                    — cron entry intentionally absent (pending validation gates)
```

Git checkpoint: (pending commit)

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

* Mock infrastructure partially mixed with real flow
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

# Current Development Priorities

Immediate priorities:

1. Live dashboard event integration
2. Real DriverEvent visibility in Audit
3. Pilot-driver operational testing
4. Audio alert system
5. Real Samsara payload validation

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

npx prisma generate
npx prisma db push
npx prisma studio
```

Current workflow still uses:

```txt
prisma db push
```

Migration-based workflow should be adopted before broader production rollout.

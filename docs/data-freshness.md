# Data Freshness & Availability Vocabularies

SafeHaul currently has **four separate, independently-defined vocabularies**
for describing how fresh/available a piece of driver context data is. They
are not unified — each is internally correct for its own field(s), but the
value sets, names, and thresholds differ across them. This document is the
single cross-reference for all four. It does not change or unify any of
them (see the Phase 5 audit, 2026-08-05, for why unification is deferred).

If you're adding a new provider-backed field, read this first and decide
which existing vocabulary it belongs to (most likely `FieldState`) rather
than inventing a fifth.

---

## 1. `FieldState` — the general-purpose vocabulary

**File:** `lib/driverContext/types.ts`
**Applies to:** every `DriverContextField<T>` — i.e. `safetyEvents`, `hos`,
`speed`, `weather`, `zoneRisk`, `location` on `DriverContext`.

```ts
type FieldState = "fresh" | "cached" | "fallback" | "unavailable";
```

| Value | Meaning |
|---|---|
| `fresh` | A real (`observed`/`estimated`) reading confirmed current this call, or an intentional demo value (`simulated` + `fresh`). |
| `cached` | A real reading exists but wasn't reconfirmed this call (e.g. an on-demand sync that didn't run, or a reading old enough to need re-checking but not old enough to discard). Only pairs with `origin: "observed"` or `"estimated"`. |
| `fallback` | `origin: "simulated"` for a **pilot** driver — a field with no real source yet, or a real source that failed and a demo-style value is being shown as a labeled substitute. Never used for a non-pilot/demo driver (they use `fresh`). |
| `unavailable` | No value could be produced. Always pairs with `value: null`. |

Threshold that decides `fresh` vs `cached` is **field-specific** — see the
per-field notes below; `FieldState` itself carries no threshold.

`origin` (`"observed" | "estimated" | "simulated" | null`) is the
companion field that says *where* the value came from; `FieldState` says
*how trustworthy the timing is*. See the "Semantic differences" section
below for the full origin × state matrix.

---

## 2. `LocationState` — GPS-gated fields only

**File:** `lib/driverContext/types.ts`
**Applies to:** `location.state` (`VehicleLocation`), and gates whether
`weather`/`zoneRisk`/`speed` may even attempt a real reading for a pilot
(see `assemble.ts`).

```ts
type LocationState = "fresh" | "stale" | "unavailable";
```

| Value | Meaning | Threshold |
|---|---|---|
| `fresh` | GPS reading confirmed current — safe to drive weather/zone/speed lookups from. | age ≤ `LOCATION_FRESH_THRESHOLD_MS` (10 min) |
| `stale` | GPS reading exists and is shown for transparency, but too old to trust as "where the truck is now" — **never** backs a weather/zone/speed lookup. | `LOCATION_FRESH_THRESHOLD_MS` < age ≤ `LOCATION_STALE_THRESHOLD_MS` (10 min – 6 hr) |
| `unavailable` | No usable GPS reading at all. | age > `LOCATION_STALE_THRESHOLD_MS` (6 hr), or no reading/vehicle ID resolvable |

**Thresholds defined in:** `lib/driverContext/assemble.ts`
(`LOCATION_FRESH_THRESHOLD_MS`, `LOCATION_STALE_THRESHOLD_MS`), applied by
`classifyLocationFreshness()`.

Note `LocationState` has **no `cached` or `fallback` value** — it's a
narrower 3-state vocabulary specific to "is this position current enough to
build other readings from," not a general provenance model.

---

## 3. `ZoneAvailability` — zone risk only

**File:** `lib/driverContext/types.ts`
**Applies to:** `ZoneDetail.availability` (and the coarser `ZoneDetail.status`
derived from it).

```ts
type ZoneAvailability =
  | "matched"
  | "outside_monitored_zones"
  | "location_unavailable"
  | "location_stale";
```

| Value | Meaning | Backing `zoneRisk` value |
|---|---|---|
| `matched` | Fresh real GPS, inside a curated zone's radius (`lib/providers/zones/zoneData.ts`). | the zone's `riskScore` |
| `outside_monitored_zones` | Fresh real GPS, but no curated zone contains it. **This is a real, available reading** — "confirmed not in a known risk zone," not a data gap. | `0` (real, not fabricated) |
| `location_stale` | Underlying `LocationState` is `stale` — no lookup could run. | `null` |
| `location_unavailable` | Underlying `LocationState` is `unavailable` — no lookup could run. | `null` |

**No independent threshold** — `ZoneAvailability` is entirely derived from
`LocationState` (see thresholds above) plus whether `matchZone()`
(`lib/providers/zones/zoneRisk.ts`) found a hit.

`ZoneDetail.status` (`"available" | "unavailable"`) is a coarser summary:
`available` = `matched` or `outside_monitored_zones`; `unavailable` =
`location_stale` or `location_unavailable`. Prefer `availability` +
`explanation` over `status` for anything user-facing — see
`ZONE_AVAILABILITY_EXPLANATIONS` in `types.ts` for the canonical wording.

**Important naming collision:** `ZoneDetail.status: "available"` does
**not** mean the same thing as `HosDetail.status: "available"` below —
they're independently-defined string unions that happen to share a word.

---

## 4. `HosDetail.status` — HOS only

**File:** `lib/driverContext/types.ts` (type), `lib/providers/samsara/hos.ts`
(threshold + derivation, via `ParsedHos.status`)

```ts
status: "available" | "unavailable" | "stale"
```

| Value | Meaning | Threshold |
|---|---|---|
| `available` | HOS clock entry found, `shiftHoursUsed` parsed, and reading is recent. | age ≤ `STALE_THRESHOLD_MS` (30 min) |
| `stale` | HOS clock entry found and parsed, but `lastUpdatedAtTime` is older than the threshold. Still backs a real `hos.value` — collapses to `FieldState: "cached"` at the field level (see `assembleHos` in `assemble.ts`). | age > `STALE_THRESHOLD_MS` (30 min) |
| `unavailable` | No mapping, no clock entry, fetch failed, or `shiftHoursUsed` couldn't be parsed. | — |

**Threshold defined in:** `lib/providers/samsara/hos.ts`
(`STALE_THRESHOLD_MS`).

Note this is a **different 30-minute window** than `LocationState`'s 10
minute/6 hour pair and `ProviderSyncState`'s 5-minute sync-freshness window
below — each was chosen independently for its own field's real-world update
cadence, not from a shared policy.

---

## 5. One more threshold, not a state enum: on-demand sync freshness

**File:** `lib/providers/samsara/onDemandSync.ts` (`FRESHNESS_MS`, 5 min)

This governs when `ensureFreshSamsaraSync()` decides the **Safety Events
stream** itself needs an on-demand refresh — a provider-sync-level
freshness check, not a per-field state. Its outcome (`OnDemandSyncStatus`:
`"fresh" | "refreshed" | "refresh_failed" | "sync_in_progress"`) feeds
`fieldStateForSyncStatus()` in `assemble.ts`, which maps it into
`safetyEvents`'s `FieldState` (`refreshed` → `fresh`, anything else →
`cached`). This is the **fifth** timing constant in the system and is
listed here for completeness even though it isn't its own value-set typedef.

---

## Semantic differences: fresh / cached-stale / unavailable / demo

These five words get used across the vocabularies above; here's what each
means when you see it, and how to tell them apart:

- **`fresh`** — a value that is both real (`observed`/`estimated`) *and*
  confirmed current within its field's threshold, **or** an intentional
  demo value (`simulated` + `fresh` — demo mode has no "staleness" concept,
  every demo reading is definitionally current).
- **`cached` / `stale`** — a value that is real but not reconfirmed current.
  `FieldState` calls this `cached`; `LocationState`, `ZoneAvailability`
  (indirectly, via `location_stale`), and `HosDetail.status` call their
  equivalent `stale`. These are the same concept under different names in
  different types — not a meaningful distinction, just inconsistent naming
  (see the Phase 5 audit for why unification is deferred).
- **`unavailable`** — no value could be produced at all. Always pairs with
  a `null` value. **Never** backfilled with a mock/demo number for a pilot
  driver — this is a hard rule enforced throughout `assemble.ts`.
- **`demo`** — not a `FieldState` value itself; it's what `origin:
  "simulated"` + `state: "fresh"` *means* for a non-pilot driver (see
  `isDemo()` in `lib/driverContext/contextStatus.ts`). A pilot driver can
  also have `origin: "simulated"`, but always with `state: "fallback"`,
  never `"fresh"` — that distinction is exactly how `deriveContextStatus()`
  tells a demo account apart from a pilot with a still-unintegrated field.
- **`not_applicable`** — does not currently exist as a value anywhere in
  this system. Every field is always in one of the states above; there is
  no "this field doesn't apply to this driver" case today. If one is ever
  needed (e.g. a future field that only exists for certain vehicle types),
  it should be a new, explicit value — not inferred from `unavailable`.

---

## Quick reference: all threshold constants

| Constant | Value | File |
|---|---|---|
| `LOCATION_FRESH_THRESHOLD_MS` | 10 min | `lib/driverContext/assemble.ts` |
| `LOCATION_STALE_THRESHOLD_MS` | 6 hr | `lib/driverContext/assemble.ts` |
| `STALE_THRESHOLD_MS` (HOS) | 30 min | `lib/providers/samsara/hos.ts` |
| `FRESHNESS_MS` (Safety Events sync) | 5 min | `lib/providers/samsara/onDemandSync.ts` |

None of these are currently centralized or derived from one another — each
was chosen independently for its field's real-world update cadence.

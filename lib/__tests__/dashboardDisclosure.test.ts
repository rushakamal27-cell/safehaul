import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  safetyEventsStatusPhrase,
  buildPartialLiveDisclosure,
  fieldStatusPhrase,
  type FieldMeta,
  type SafetyEventsSyncInfo,
} from "../dashboardDisclosure";
import type { ContextSources, ZoneDetail } from "../driverContext/types";

// N2 (Phase 5, 2026-08-05) — regression coverage for the fix: the safety
// events disclosure line must describe PROVIDER SYNC recency
// (liveData.lastSyncTime), never the latest real event's age. Before this
// fix, a long, event-free (safe) driving stretch with a perfectly current
// sync would misleadingly read as "Cached (Samsara, 340 min old)" — as if
// the sync itself were stale/broken.

const NOW = new Date("2026-08-05T12:00:00.000Z");

function cachedSafetyEventsMeta(observedAt: string | null): FieldMeta {
  return { origin: "observed", state: "cached", provider: "samsara", observedAt };
}

function liveSafetyEventsMeta(observedAt: string): FieldMeta {
  return { origin: "observed", state: "fresh", provider: "samsara", observedAt };
}

function demoSafetyEventsMeta(observedAt: string): FieldMeta {
  return { origin: "simulated", state: "fresh", provider: "internal", observedAt };
}

describe("safetyEventsStatusPhrase", () => {
  test("recent sync with no recent safety event: describes sync recency, not the (old/absent) event's age", () => {
    // observedAt falls back to a much older real event's timestamp (or, per
    // assembleSafetyEvents, lastSyncAt/now when there are zero events at
    // all) — either way it must NOT drive the displayed minutes here.
    const meta = cachedSafetyEventsMeta("2026-08-05T06:00:00.000Z"); // 6 hours old
    const liveData: SafetyEventsSyncInfo = { lastSyncTime: "2026-08-05T11:58:00.000Z" }; // 2 min ago

    const phrase = safetyEventsStatusPhrase(meta, liveData, NOW);

    assert.equal(phrase, "Safety events: Synced 2 min ago (Samsara).");
    assert.doesNotMatch(phrase, /360 min old/, "must not describe the stale event age as if it were sync staleness");
  });

  test("old event with recent sync: still reports the sync's own recency, unaffected by how old the last event was", () => {
    const meta = cachedSafetyEventsMeta("2026-08-05T02:00:00.000Z"); // 10 hours old
    const liveData: SafetyEventsSyncInfo = { lastSyncTime: "2026-08-05T11:59:00.000Z" }; // 1 min ago

    const phrase = safetyEventsStatusPhrase(meta, liveData, NOW);

    assert.equal(phrase, "Safety events: Synced 1 min ago (Samsara).");
  });

  test("unavailable sync timestamp (liveData null): degrades gracefully, never implies the provider hasn't synced", () => {
    const meta = cachedSafetyEventsMeta("2026-08-05T06:00:00.000Z");

    const phrase = safetyEventsStatusPhrase(meta, null, NOW);

    assert.equal(phrase, "Safety events: Cached (Samsara).");
    assert.doesNotMatch(phrase, /not synced|never synced|no sync/i, "absence of a sync timestamp must not read as 'provider has not synced'");
  });

  test("unavailable sync timestamp (lastSyncTime explicitly null): same graceful degradation", () => {
    const meta = cachedSafetyEventsMeta("2026-08-05T06:00:00.000Z");
    const liveData: SafetyEventsSyncInfo = { lastSyncTime: null };

    const phrase = safetyEventsStatusPhrase(meta, liveData, NOW);

    assert.equal(phrase, "Safety events: Cached (Samsara).");
  });

  test("real (live) data: unaffected by the sync-recency change — still 'Live', not sync-age wording", () => {
    const meta = liveSafetyEventsMeta("2026-08-05T11:59:50.000Z");
    const liveData: SafetyEventsSyncInfo = { lastSyncTime: "2026-08-05T11:59:50.000Z" };

    const phrase = safetyEventsStatusPhrase(meta, liveData, NOW);

    assert.equal(phrase, "Safety events: Live (Samsara).");
  });

  test("demo data: unaffected by the sync-recency change — still 'Demo Data', liveData ignored (always null for demo in practice)", () => {
    const meta = demoSafetyEventsMeta("2026-08-05T12:00:00.000Z");

    const phraseWithNullLiveData = safetyEventsStatusPhrase(meta, null, NOW);
    assert.equal(phraseWithNullLiveData, "Safety events: Demo Data.");

    // Even if a caller somehow passed sync info alongside demo-classified
    // metadata, demo wording must still win — sync recency is only ever
    // meaningful for real (observed) data.
    const phraseWithSyncInfo = safetyEventsStatusPhrase(meta, { lastSyncTime: "2026-08-05T11:59:00.000Z" }, NOW);
    assert.equal(phraseWithSyncInfo, "Safety events: Demo Data.");
  });

  test("unavailable safety events: unaffected, still 'Unavailable' regardless of liveData", () => {
    const meta: FieldMeta = { origin: null, state: "unavailable", provider: null, observedAt: null };
    const phrase = safetyEventsStatusPhrase(meta, { lastSyncTime: "2026-08-05T11:59:00.000Z" }, NOW);
    assert.equal(phrase, "Safety events: Unavailable.");
  });
});

describe("buildPartialLiveDisclosure — safety events integration", () => {
  const NEUTRAL_META: FieldMeta = { origin: null, state: "unavailable", provider: null, observedAt: null };

  function baseSources(overrides: Partial<ContextSources> = {}): ContextSources {
    return {
      safetyEvents: NEUTRAL_META,
      hos: NEUTRAL_META,
      speed: NEUTRAL_META,
      weather: NEUTRAL_META,
      zoneRisk: NEUTRAL_META,
      location: NEUTRAL_META,
      ...overrides,
    };
  }

  const UNAVAILABLE_ZONE: ZoneDetail = {
    zoneRisk: null,
    zoneName: null,
    zoneType: null,
    zoneExplanation: null,
    availability: "location_unavailable",
    explanation: "Location unavailable",
    status: "unavailable",
    origin: null,
    provider: null,
    observedAt: null,
    fetchedAt: NOW.toISOString(),
    latitude: null,
    longitude: null,
    locationState: "unavailable",
    locationObservedAt: null,
    matchedZoneId: null,
    distanceMiles: null,
  };

  test("full disclosure uses sync recency for safety events, not event age, and leaves other fields untouched", () => {
    const sources = baseSources({
      safetyEvents: cachedSafetyEventsMeta("2026-08-04T12:00:00.000Z"), // 24h old event
      hos: { origin: "observed", state: "cached", provider: "samsara", observedAt: "2026-08-05T11:30:00.000Z" },
    });
    const liveData: SafetyEventsSyncInfo = { lastSyncTime: "2026-08-05T11:59:00.000Z" };

    const disclosure = buildPartialLiveDisclosure(sources, UNAVAILABLE_ZONE, liveData, NOW);

    assert.match(disclosure, /^Safety events: Synced 1 min ago \(Samsara\)\./, "safety events phrase must lead the disclosure, using sync recency");
    assert.doesNotMatch(disclosure, /Safety events:.*1440 min old/, "must never use the 24h-old event's age for safety events");
    assert.match(disclosure, /HOS: Cached \(Samsara, 30 min old\)\./, "other fields still use their own observedAt-based wording, unchanged");
  });
});

// Localization (2026-08-27) — `language` is additive/optional; every test
// above (no language arg) must keep passing unmodified, verified by the
// full suite still being green. These cover the new "ru" path specifically.
describe("language parameter (localization)", () => {
  test("safetyEventsStatusPhrase: 'ru' translates the sentence, keeps the brand name (Samsara) untranslated", () => {
    const meta = cachedSafetyEventsMeta("2026-08-05T06:00:00.000Z");
    const liveData: SafetyEventsSyncInfo = { lastSyncTime: "2026-08-05T11:58:00.000Z" };

    const phrase = safetyEventsStatusPhrase(meta, liveData, NOW, "ru");

    assert.equal(phrase, "События безопасности: синхронизировано 2 мин назад (Samsara).");
  });

  test("safetyEventsStatusPhrase: 'ru' demo wording", () => {
    const meta = demoSafetyEventsMeta("2026-08-05T12:00:00.000Z");
    const phrase = safetyEventsStatusPhrase(meta, null, NOW, "ru");
    assert.equal(phrase, "События безопасности: демо-данные.");
  });

  test("fieldStatusPhrase: 'ru' live/cached/unavailable wording, provider untranslated", () => {
    const live: FieldMeta = { origin: "observed", state: "fresh", provider: "samsara", observedAt: "2026-08-05T11:59:00.000Z" };
    assert.equal(fieldStatusPhrase("Weather", live, NOW, "ru"), "Погода: в реальном времени (Samsara).");

    const cached: FieldMeta = { origin: "observed", state: "cached", provider: "samsara", observedAt: "2026-08-05T11:30:00.000Z" };
    assert.equal(fieldStatusPhrase("HOS", cached, NOW, "ru"), "Часы работы (HOS): кэш (Samsara, 30 мин назад).");

    const unavailable: FieldMeta = { origin: null, state: "unavailable", provider: null, observedAt: null };
    assert.equal(fieldStatusPhrase("Speed", unavailable, NOW, "ru"), "Скорость: недоступно.");
  });

  test("buildPartialLiveDisclosure: 'ru' end-to-end, default (no language arg) still produces the original English disclosure", () => {
    const NEUTRAL_META: FieldMeta = { origin: null, state: "unavailable", provider: null, observedAt: null };
    const sources = {
      safetyEvents: cachedSafetyEventsMeta("2026-08-04T12:00:00.000Z"),
      hos: { origin: "observed", state: "cached", provider: "samsara", observedAt: "2026-08-05T11:30:00.000Z" } as FieldMeta,
      speed: NEUTRAL_META,
      weather: NEUTRAL_META,
      zoneRisk: NEUTRAL_META,
      location: NEUTRAL_META,
    };
    const unavailableZone = {
      zoneRisk: null, zoneName: null, zoneType: null, zoneExplanation: null,
      availability: "location_unavailable" as const, explanation: "Location unavailable",
      status: "unavailable" as const, origin: null, provider: null, observedAt: null,
      fetchedAt: NOW.toISOString(), latitude: null, longitude: null,
      locationState: "unavailable" as const, locationObservedAt: null,
      matchedZoneId: null, distanceMiles: null,
    };
    const liveData: SafetyEventsSyncInfo = { lastSyncTime: "2026-08-05T11:59:00.000Z" };

    const englishDefault = buildPartialLiveDisclosure(sources, unavailableZone, liveData, NOW);
    assert.match(englishDefault, /^Safety events: Synced 1 min ago \(Samsara\)\./);

    const russian = buildPartialLiveDisclosure(sources, unavailableZone, liveData, NOW, "ru");
    assert.match(russian, /^События безопасности: синхронизировано 1 мин назад \(Samsara\)\./);
    assert.match(russian, /Часы работы \(HOS\): кэш \(Samsara, 30 мин назад\)\./);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyLegacyRiskRow, isLegacySyntheticRow } from "../legacyHistory";

// Legacy synthetic-history exclusion (2026-10-08). The rule has two
// positively-identifying cases and one honest unknown; these tests pin all
// three, plus the boundary between them and the real production shapes that
// motivated it.

const MAPPED_AT = new Date("2026-06-08T20:51:47.000Z"); // a real onboarding instant

describe("classifyLegacyRiskRow — rule 1: driver never mapped to any provider", () => {
  test("synthetic: a driver with no mapping could never have been a pilot", () => {
    assert.equal(
      classifyLegacyRiskRow({
        rowCreatedAt: new Date("2026-04-10T21:31:31.641Z"),
        providerMappingCreatedAt: null,
      }),
      "synthetic"
    );
  });

  test("synthetic regardless of how recent the row is", () => {
    // There is no date component to this rule at all — an unmapped driver's
    // rows are synthetic whenever they were written.
    for (const iso of ["2026-01-01T00:00:00.000Z", "2026-10-07T23:59:59.999Z"]) {
      assert.equal(
        classifyLegacyRiskRow({ rowCreatedAt: new Date(iso), providerMappingCreatedAt: null }),
        "synthetic",
        `expected synthetic for ${iso}`
      );
    }
  });
});

describe("classifyLegacyRiskRow — rule 2: row predates the driver's mapping", () => {
  test("synthetic: at write time the driver had no mapping, so context was mock", () => {
    assert.equal(
      classifyLegacyRiskRow({
        rowCreatedAt: new Date("2026-06-06T12:00:00.000Z"), // 2 days before onboarding
        providerMappingCreatedAt: MAPPED_AT,
      }),
      "synthetic"
    );
  });

  test("synthetic one millisecond before the mapping exists", () => {
    assert.equal(
      classifyLegacyRiskRow({
        rowCreatedAt: new Date(MAPPED_AT.getTime() - 1),
        providerMappingCreatedAt: MAPPED_AT,
      }),
      "synthetic"
    );
  });
});

describe("classifyLegacyRiskRow — rule 3: mapping existed, so NOT confidently synthetic", () => {
  test("ambiguous: a row written after onboarding may be genuine pilot history", () => {
    assert.equal(
      classifyLegacyRiskRow({
        rowCreatedAt: new Date("2026-07-28T10:00:00.000Z"),
        providerMappingCreatedAt: MAPPED_AT,
      }),
      "ambiguous"
    );
  });

  test("ambiguous at the exact mapping instant — the boundary is INCLUSIVE of keeping", () => {
    // Strict `<` in rule 2 means a row created in the same instant as the
    // mapping is not provably pre-mapping. Deliberately errs toward showing
    // the row rather than hiding possibly-genuine history.
    assert.equal(
      classifyLegacyRiskRow({
        rowCreatedAt: new Date(MAPPED_AT.getTime()),
        providerMappingCreatedAt: MAPPED_AT,
      }),
      "ambiguous"
    );
  });

  test("ambiguous one millisecond after the mapping exists", () => {
    assert.equal(
      classifyLegacyRiskRow({
        rowCreatedAt: new Date(MAPPED_AT.getTime() + 1),
        providerMappingCreatedAt: MAPPED_AT,
      }),
      "ambiguous"
    );
  });
});

describe("isLegacySyntheticRow — only 'synthetic' is excluded", () => {
  test("ambiguous rows are KEPT: unknown provenance must not hide real history", () => {
    assert.equal(
      isLegacySyntheticRow({
        rowCreatedAt: new Date(MAPPED_AT.getTime() + 1000),
        providerMappingCreatedAt: MAPPED_AT,
      }),
      false
    );
  });

  test("both synthetic cases are excluded", () => {
    assert.equal(
      isLegacySyntheticRow({ rowCreatedAt: new Date("2026-04-10T00:00:00.000Z"), providerMappingCreatedAt: null }),
      true
    );
    assert.equal(
      isLegacySyntheticRow({ rowCreatedAt: new Date(MAPPED_AT.getTime() - 1000), providerMappingCreatedAt: MAPPED_AT }),
      true
    );
  });
});

describe("the rule takes no date threshold of its own", () => {
  test("the same row date classifies differently per driver — it is causal, not calendar-based", () => {
    // Requirement: no broad date-based filtering that could exclude genuine
    // records. The identical instant is synthetic for one driver and
    // ambiguous for another, purely because of when each was onboarded.
    const rowCreatedAt = new Date("2026-07-01T00:00:00.000Z");
    const earlyOnboard = new Date("2026-05-21T13:36:15.000Z"); // Temurbek-shaped
    const lateOnboard  = new Date("2026-08-27T10:35:44.000Z"); // Luka-shaped

    assert.equal(classifyLegacyRiskRow({ rowCreatedAt, providerMappingCreatedAt: earlyOnboard }), "ambiguous");
    assert.equal(classifyLegacyRiskRow({ rowCreatedAt, providerMappingCreatedAt: lateOnboard }), "synthetic");
  });

  test("current isPilot/isActive flags are NOT inputs — a deactivated pilot is handled by date alone", () => {
    // The input type has no flag fields at all, which is the enforcement.
    // A deactivated pilot (mapping present, flags false) whose rows predate
    // the mapping is still correctly synthetic; one whose rows postdate it is
    // ambiguous, exactly as for an active pilot. This is the Justin case:
    // mapping created after his pre-onboarding demo rows were written.
    const justinMappedAt = new Date("2026-08-27T00:00:00.000Z");
    assert.equal(
      classifyLegacyRiskRow({
        rowCreatedAt: new Date("2026-08-25T04:55:00.000Z"),
        providerMappingCreatedAt: justinMappedAt,
      }),
      "synthetic"
    );
  });
});

describe("production shapes measured on 2026-10-08", () => {
  test("every SafetyEvent row in production classifies as synthetic", () => {
    // 93 rows: 51 for never-mapped drivers (rule 1), 42 predating their
    // driver's mapping (rule 2), 0 ambiguous. Representative samples of each.
    const neverMapped = { rowCreatedAt: new Date("2026-04-11T00:00:00.000Z"), providerMappingCreatedAt: null };
    const preMapping  = { rowCreatedAt: new Date("2026-06-06T00:00:00.000Z"), providerMappingCreatedAt: MAPPED_AT };
    assert.equal(isLegacySyntheticRow(neverMapped), true);
    assert.equal(isLegacySyntheticRow(preMapping), true);
  });

  test("the 32 Trip + 32 ComplianceScore rows belonging to onboarded pilots stay visible", () => {
    // Rushana (22) and Temurbek (10) — rows created after each was mapped and
    // before the write path became demo-only. Possibly genuine real-context
    // pilot history, so they are reported as ambiguous, never hidden.
    assert.equal(
      isLegacySyntheticRow({
        rowCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
        providerMappingCreatedAt: MAPPED_AT,
      }),
      false
    );
  });
});

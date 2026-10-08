import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldPersistDailyHistory } from "../riskPersistence";

// Three driver categories reach /api/risk. Only the first may write the
// legacy demo history (Trip / ComplianceScore / SafetyEvent), because only
// it has no autonomous collection pipeline and no real provider data.
//
//   genuine demo user          — no provider mapping at all        -> writes
//   active pilot driver        — mapping, isPilot && isActive      -> no
//   deactivated/former pilot   — mapping, but not pilot+active     -> no
//
// The third row is the Phase 6D closure fix: the predicate used to be
// `!pilotDriver`, so a pilot who was set to isPilot=false/isActive=false in
// production would have started receiving MOCK mileage, a mock-context
// ComplianceScore and fabricated SafetyEvent rows on his next app open.

describe("shouldPersistDailyHistory — genuine demo user (no provider mapping)", () => {
  test("persists: this route is their only history source", () => {
    assert.equal(
      shouldPersistDailyHistory({ pilotDriver: false, hasProviderMapping: false }),
      true
    );
  });
});

describe("shouldPersistDailyHistory — active pilot driver", () => {
  test("does NOT persist: history is owned by the autonomous riskSampling pipeline", () => {
    assert.equal(
      shouldPersistDailyHistory({ pilotDriver: true, hasProviderMapping: true }),
      false
    );
  });
});

describe("shouldPersistDailyHistory — deactivated / former pilot driver", () => {
  test("does NOT persist: deactivation must stop collection, not switch it to synthetic data", () => {
    // The real production case: isPilot=false, isActive=false, mapping row
    // still present. Under the old `!pilotDriver` predicate this returned
    // true and would have fabricated Trip/ComplianceScore/SafetyEvent rows.
    assert.equal(
      shouldPersistDailyHistory({ pilotDriver: false, hasProviderMapping: true }),
      false
    );
  });

  test("a mapping that exists is enough to refuse — the flags themselves are not re-read here", () => {
    // Covers isPilot=true/isActive=false and isPilot=false/isActive=true
    // equally: both yield pilotDriver=false (isPilotDriver requires BOTH)
    // with a mapping present, so both land on this same branch.
    assert.equal(
      shouldPersistDailyHistory({ pilotDriver: false, hasProviderMapping: true }),
      false
    );
  });
});

describe("shouldPersistDailyHistory — defensive / impossible combination", () => {
  test("an active pilot reported without a mapping still does NOT persist", () => {
    // Not reachable in practice (isPilotDriver reads the mapping, so
    // pilotDriver=true implies a mapping exists), but if the two facts ever
    // disagree the predicate must fail closed rather than fabricate data.
    assert.equal(
      shouldPersistDailyHistory({ pilotDriver: true, hasProviderMapping: false }),
      false
    );
  });
});

describe("shouldPersistDailyHistory — truth table is exhaustive and total", () => {
  test("exactly one of the four input combinations permits a write", () => {
    const combos = [true, false].flatMap((pilotDriver) =>
      [true, false].map((hasProviderMapping) => ({ pilotDriver, hasProviderMapping }))
    );
    const permitted = combos.filter((c) => shouldPersistDailyHistory(c));
    assert.equal(permitted.length, 1);
    assert.deepEqual(permitted[0], { pilotDriver: false, hasProviderMapping: false });
  });

  test("the predicate is pure — same input, same answer, no side effects", () => {
    const input = { pilotDriver: false, hasProviderMapping: true };
    assert.equal(shouldPersistDailyHistory(input), shouldPersistDailyHistory(input));
    assert.deepEqual(input, { pilotDriver: false, hasProviderMapping: true });
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isRiskScoreable } from "../riskScoreability";
import type { ContextStatus, DriverContext } from "../driverContext/types";
import { calculateRisk } from "../riskEngine";
import { toRiskInput } from "../driverContext/toRiskInput";
import { deriveContextStatus } from "../driverContext/contextStatus";

// Remove Implicit Demo Fallback (2026-10-08). This predicate is the guard
// against the failure mode that step 1 alone would have created: an empty
// context, run through toRiskInput's neutral `?? 0` defaults, scores 100 /
// LOW / no factors. Fabricated mediocre numbers would have become fabricated
// perfect ones.

describe("isRiskScoreable", () => {
  test("insufficient_context is NOT scoreable — this is the whole point", () => {
    assert.equal(isRiskScoreable("insufficient_context"), false);
  });

  test("full_live is scoreable", () => {
    assert.equal(isRiskScoreable("full_live"), true);
  });

  test("partial_live is scoreable — some live positional evidence is enough", () => {
    assert.equal(isRiskScoreable("partial_live"), true);
  });

  test("demo remains scoreable: unreachable from live assembly, but still classified for stored rows", () => {
    // Deliberate. Nothing produces all-simulated fields from a live request
    // any more, but deriveContextStatusFromSources still returns "demo" for
    // historical contextSources, and a future explicit opt-in Demo Mode would
    // legitimately score. This predicate is about data sufficiency only.
    assert.equal(isRiskScoreable("demo"), true);
  });
});

describe("isRiskScoreable — total over the ContextStatus union", () => {
  test("exactly one of the four statuses withholds the score", () => {
    const all: ContextStatus[] = ["full_live", "partial_live", "insufficient_context", "demo"];
    const withheld = all.filter((s) => !isRiskScoreable(s));
    assert.deepEqual(withheld, ["insufficient_context"]);
  });

  test("pure — same input, same answer", () => {
    assert.equal(isRiskScoreable("insufficient_context"), isRiskScoreable("insufficient_context"));
  });
});

// The hazard this predicate exists to prevent, asserted directly against the
// real engine rather than described in a comment. If calculateRisk ever stops
// returning a benign score for an empty context, this test fails and the
// guard can be reconsidered — but it must never fail silently in the other
// direction, which is why the exact score is pinned.
describe("why the guard is needed: an empty context scores as SAFE", () => {
  test("all-unavailable context yields a confident, unearned perfect score", () => {
    const unavailable = { value: null, origin: null, state: "unavailable", provider: null, observedAt: null } as const;
    const context = {
      driverId: "empty-context-driver",
      calculatedAt: "2026-10-08T12:00:00.000Z",
      safetyEvents: unavailable,
      hos: unavailable,
      speed: unavailable,
      weather: unavailable,
      zoneRisk: unavailable,
      location: unavailable,
    } as unknown as DriverContext;

    const result = calculateRisk(toRiskInput(context));

    // toRiskInput's `?? 0` neutral defaults cannot fabricate a PENALTY, but
    // they do fabricate the ABSENCE of one, which the engine reads as a clean
    // record. This is the "UNKNOWN != SAFE" failure mode.
    assert.equal(result.score, 100, "an empty context scores 100 — maximally reassuring, entirely unfounded");
    assert.equal(result.level, "LOW");
    assert.equal(result.factors.length, 0, "and offers no factors that would hint the score is hollow");

    // Which is exactly why the API must withhold it.
    assert.equal(isRiskScoreable(deriveContextStatus(context)), false);
  });
});

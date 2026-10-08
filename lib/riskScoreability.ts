/**
 * lib/riskScoreability.ts
 *
 * One question: may /api/risk return a risk score at all?
 *
 * Remove Implicit Demo Fallback (2026-10-08). Making non-pilot context
 * unavailable (step 1) is necessary but NOT sufficient. lib/driverContext/
 * toRiskInput.ts substitutes neutral `?? 0` defaults for missing fields, and
 * lib/riskEngine.ts's calculateRisk() has no way to distinguish "measured
 * zero risk" from "measured nothing." Feed it an entirely empty context and
 * it returns a confident score of 100, LOW risk, zero factors — the most
 * dangerous possible output, because it is both maximally reassuring and
 * completely unfounded. Suppressing simulated inputs without also suppressing
 * the score would therefore have replaced fabricated mediocre scores with
 * fabricated perfect ones.
 *
 * So the score is withheld whenever the context was classified
 * insufficient_context. That classification already exists and already has
 * exactly the right semantics — see deriveContextStatusFromSources in
 * ./driverContext/contextStatus.ts, where hasNoLivePositionalInput means "the
 * engine saw no situational evidence at all." Reusing it keeps ONE definition
 * of "not enough to score" shared by the live API, the hourly sampler and the
 * daily finalizer, instead of a second, drifting rule here.
 *
 * Two driver situations land here, and they are deliberately treated
 * identically:
 *
 *   - a normal user with no active pilot mapping (never-mapped, deactivated,
 *     or a test/demo account) — every field unavailable by construction;
 *   - an ACTIVE pilot whose GPS/provider data could not be resolved this
 *     call — a real driver we genuinely cannot assess right now.
 *
 * The second is the reason this is not merely a demo-account concern, and why
 * the rule is written against context quality rather than against pilot
 * status: "we don't know" must never render as "you're safe," whoever asks.
 *
 * Pure and dependency-free so it is directly unit-testable; app/api/risk/
 * route.ts is outside this project's lib/**\/__tests__ test glob.
 */

import type { ContextStatus } from "@/lib/driverContext/types";

/**
 * | contextStatus        | scoreable | meaning                               |
 * |----------------------|-----------|---------------------------------------|
 * | full_live            | yes       | every scoring field live              |
 * | partial_live         | yes       | some live positional evidence         |
 * | demo                 | yes       | all-simulated; unreachable from live  |
 * |                      |           | assembly now, still produced for      |
 * |                      |           | historical rows — see                 |
 * |                      |           | lib/dataQuality/historicalSamples.ts  |
 * | insufficient_context | NO        | no situational evidence at all        |
 *
 * `demo` stays scoreable on purpose. It cannot arise from a live request any
 * more (nothing produces all-simulated fields), but the value is still
 * classified for stored rows, and a future EXPLICIT opt-in Demo Mode would
 * legitimately want a score. Treating it as unscoreable here would bake a
 * second, hidden policy into a predicate that is only about data sufficiency.
 */
export function isRiskScoreable(contextStatus: ContextStatus): boolean {
  return contextStatus !== "insufficient_context";
}

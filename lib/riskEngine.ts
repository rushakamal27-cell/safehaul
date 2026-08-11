export interface RiskInput {
  safetyEvents: { type: string; severity: number }[];
  // null when HOS is genuinely unknown (e.g. a pilot driver with no
  // resolvable/reachable Samsara HOS source this call) — must not be
  // defaulted to a number, since 0 would silently claim "no fatigue" for a
  // fact the engine doesn't actually have.
  hosHours: number | null;
  weatherRisk: number; // 0–1
  zoneRisk: number;    // 0–1
  speed: number;       // mph
  // Phase 4.5 — Contextual Speed: whether weatherRisk/zoneRisk/hosHours are a
  // trustworthy signal (a real observed/estimated reading, or an intentional
  // demo-mode value) rather than a data gap defaulted to 0/null upstream
  // (lib/driverContext/toRiskInput.ts). calculateRisk() deliberately does not
  // import lib/driverContext (see toRiskInput.ts's header comment) — these
  // plain booleans are the seam that lets the contextual speed multiplier
  // know a modifier's input is missing without leaking DriverContextField's
  // origin/state vocabulary into the engine. Optional and defaulting to
  // `true` so existing call sites/tests that don't set them are unaffected.
  weatherAvailable?: boolean;
  zoneRiskAvailable?: boolean;
  hosAvailable?: boolean;
}

export interface RiskFactor {
  name: string;
  impact: number; // percentage of total penalty, sums to 100
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RiskTrend = "IMPROVING" | "STABLE" | "WORSENING";

// ---------------------------------------------------------------------------
// Contextual Speed (Phase 4.5) — explainability types
// ---------------------------------------------------------------------------

export type ContextualSpeedComponentKey = "weather" | "zone" | "fatigue" | "behavior";

export interface ContextualSpeedComponent {
  key: ContextualSpeedComponentKey;
  label: string;
  /** e.g. 0.4 = +40% added to the multiplier. 0 when excluded (unavailable context, or no contribution). */
  modifier: number;
  /** false when this component's input was unavailable and was excluded rather than silently treated as 0-risk. */
  included: boolean;
}

export interface ContextualSpeed {
  /** false when there's no speed exposure to amplify (speedExposure === 0) — no modifiers were computed or matter. */
  active: boolean;
  /**
   * Continuous absolute kinetic exposure from current vehicle speed (Phase
   * 4.5 refinement — see calculateSpeedExposure). NOT speeding relative to a
   * posted or legal limit; SafeHaul has no posted-speed-limit source. Named
   * `speedExposure` rather than `basePenalty` because it is no longer
   * gated by a fixed mph threshold — it is nonzero (if small) starting well
   * below highway speed, and grows continuously with no jump anywhere.
   */
  speedExposure: number;
  multiplier: number;
  finalPenalty: number;
  /** true only when weather, zone risk, and HOS were all trustworthy inputs (see RiskInput's *Available flags). */
  contextComplete: boolean;
  /** Driver-facing labels for whichever inputs were unavailable, e.g. ["HOS", "Zone risk"]. Empty when contextComplete. */
  missingContext: string[];
  components: ContextualSpeedComponent[];
}

export interface RiskOutput {
  score: number;
  level: RiskLevel;
  trend: RiskTrend;
  factors: RiskFactor[];
  recommendations: string[];
  contextualSpeed: ContextualSpeed;
}

// ---------------------------------------------------------------------------
// Penalty calculators
// ---------------------------------------------------------------------------

/**
 * Phase 6A (2026-08-xx) — following_distance and rolling_stop weights.
 * Both set to 1.5, tied with the lowest existing tier (harsh_accel/
 * harsh_turn), deliberately conservative: as of this phase, EVERY real
 * event of either type ever observed for this fleet (9 following_distance,
 * 2 rolling_stop) arrived with no Samsara-reported severity at all and
 * normalized to the fallback value of 3 — there is no real severity
 * differentiation signal yet, and the sample size is thin. See the Phase
 * 6A plan (2026-08-xx) for the calibration reasoning and simulated
 * before/after scores this was chosen against.
 */
const FOLLOWING_DISTANCE_WEIGHT = 1.5;
const ROLLING_STOP_WEIGHT = 1.5;

/**
 * TEMPORARY pilot safeguard (Phase 6A, 2026-08-xx) — NOT a statistically
 * validated threshold. Caps how many following_distance / rolling_stop
 * events can contribute to THIS SCORE CALCULATION within one call's event
 * window; the 4th+ occurrence of either type in the same call still counts
 * toward every other purpose (RawProviderEvent/DriverEvent storage, the
 * Audit trail, liveData.driverEventCount24h) — only the scoring
 * contribution stops growing.
 *
 * Chosen as the exact ceiling of the largest real same-day cluster
 * observed to date (following_distance: 3 events for one driver on
 * 2026-07-24) — a forward-looking guard against unbounded accumulation
 * from a single sustained condition (e.g. stuck behind traffic on a long
 * highway stretch re-triggering the same underlying event), not a clip on
 * anything actually seen. rolling_stop has never clustered in real data
 * (2 total events, ever, on different days for different drivers) but is
 * capped identically for consistency and because a discrete violation type
 * could in principle still repeat rapidly (e.g. a residential route with
 * several closely-spaced stop signs) — this errs conservative rather than
 * leaving one of the two new, low-confidence signals unbounded while the
 * other is bounded. Revisit (raise, lower, remove, or replace with a real
 * statistical treatment) once meaningfully more real data accumulates for
 * both types — this is explicitly a pilot-stage placeholder, not a
 * permanent design decision.
 */
const FOLLOWING_DISTANCE_MAX_COUNTED = 3;
const ROLLING_STOP_MAX_COUNTED = 3;

function calcSafetyEventPenalties(
  events: RiskInput["safetyEvents"]
): {
  harshBraking: number;
  speeding: number;
  harshManeuver: number;
  distraction: number;
  mechanical: number;
  followingDistance: number;
  rollingStop: number;
} {
  let harshBraking       = 0;
  let speeding           = 0;
  let harshManeuver      = 0;
  let distraction        = 0;
  let mechanical         = 0;
  let followingDistance  = 0;
  let rollingStop        = 0;

  // Counters for the temporary per-type caps above — count EVERY occurrence
  // (so the cap comparison is correct) even though only the first
  // FOLLOWING_DISTANCE_MAX_COUNTED / ROLLING_STOP_MAX_COUNTED add to the
  // penalty sum. Local to one calcSafetyEventPenalties call, matching the
  // existing 24-hour event window (lib/driverEvents.ts::getRecentDriverEvents)
  // — never persisted, never affects storage or counts shown elsewhere.
  let followingDistanceCount = 0;
  let rollingStopCount       = 0;

  for (const event of events) {
    switch (event.type) {
      case "harsh_braking":          harshBraking  += 2   * event.severity; break;
      case "speeding":               speeding      += 3   * event.severity; break;
      case "harsh_accel":            harshManeuver += 1.5 * event.severity; break;
      case "harsh_turn":             harshManeuver += 1.5 * event.severity; break;
      case "mobile_usage":           distraction   += 3   * event.severity; break;
      case "inattentive_driving":    distraction   += 2.5 * event.severity; break;
      case "high_speed_power_loss":  mechanical    += 4   * event.severity; break;
      case "following_distance":
        followingDistanceCount++;
        if (followingDistanceCount <= FOLLOWING_DISTANCE_MAX_COUNTED) {
          followingDistance += FOLLOWING_DISTANCE_WEIGHT * event.severity;
        }
        break;
      case "rolling_stop":
        rollingStopCount++;
        if (rollingStopCount <= ROLLING_STOP_MAX_COUNTED) {
          rollingStop += ROLLING_STOP_WEIGHT * event.severity;
        }
        break;
      // "crash" (2026-08-xx) is deliberately NOT scored here — a crash is
      // an observed outcome, not (yet) treated as a predictive precursor
      // the way harsh braking/speeding/etc. are. It is normalized and
      // persisted as a DriverEvent (see lib/providers/samsara/normalizeEvent.ts)
      // so it appears correctly in Audit/history, but this switch has no
      // `default` case and `RiskInput.safetyEvents[].type` is a plain
      // `string` (not the DriverEventType union), so an explicit no-op
      // case isn't structurally required — it's written out anyway so
      // this is a documented decision, not a silent gap. Revisit once
      // there's a real product/data reason to weight it (e.g. correlating
      // crash history with subsequent risk, which needs labeled outcome
      // data SafeHaul doesn't have yet — see the Phase 5 audit's Item 5).
      case "crash": break;
    }
  }

  return { harshBraking, speeding, harshManeuver, distraction, mechanical, followingDistance, rollingStop };
}

function calcFatiguePenalty(hosHours: number | null): number {
  if (hosHours === null) return 0;
  return hosHours > 8 ? (hosHours - 8) * 2 : 0;
}

function calcWeatherPenalty(weatherRisk: number): number {
  return weatherRisk * 20;
}

function calcZonePenalty(zoneRisk: number): number {
  return zoneRisk * 15;
}

// ---------------------------------------------------------------------------
// Contextual Speed (Phase 4.5, refined)
//
// speedExposure × contextMultiplier, where the multiplier amplifies real
// speed exposure by conditions that make that speed more dangerous — bad
// weather, a high-risk zone, driver fatigue, and recent distraction/harsh-
// maneuver behavior. Deliberately NOT a multiplicative `speed × weather ×
// zone × fatigue × behavior` formula (that can collapse toward zero or grow
// unbounded) — see calculateContextualSpeedPenalty for the additive,
// capped-multiplier model instead.
//
// speedExposure itself was originally a fixed `speed > 70 ? ... : 0` cliff.
// That produced an arbitrary discontinuity (69 mph = 0 risk, 71 mph = risk)
// and meant dangerous context (severe weather, a high-risk zone, a fatigued
// driver) at 65 mph was always invisible to Contextual Speed, no matter how
// dangerous the conditions — the threshold, not the context, decided
// whether Contextual Speed had anything to amplify. calculateSpeedExposure
// below replaces it with a continuous, monotonic curve so speed contributes
// progressively and context is what decides how much that exposure matters.
//
// Double-counting note (Part D): harsh braking / harsh turn / mobile usage /
// inattentive driving are ALREADY penalized directly by
// calcSafetyEventPenalties above, independent of current speed. The behavior
// modifier here does not add a second flat penalty for those events — it
// only scales the *speed* penalty, and only when there IS a nonzero
// speedExposure to scale. A distracted driver going 15 mph pays the event
// penalty only (speedExposure is ~0, so the modifier has nothing to scale);
// a distracted driver going 85 mph pays the event penalty AND a larger speed
// penalty. This is intentional, not accidental double-counting: the event
// itself is always wrong regardless of speed, but it's specifically more
// dangerous when combined with speeding, and the multiplier's cap (see
// MULTIPLIER_CAP below) keeps the interaction bounded.
//
// `speeding` events are deliberately EXCLUDED from the behavior modifier
// (BEHAVIOR_RELEVANT_EVENT_TYPES below), unlike harsh braking/turn/
// distraction. A Samsara "speeding" event and a high real-time GPS speed
// reading are two observations of substantially the same underlying fact —
// letting a speeding event also amplify the continuous speed-exposure
// penalty would charge that one fact twice through two coupled channels.
// Harsh braking/turn/distraction are behaviorally independent of current
// speed (a driver can be distracted or brake harshly at any speed), so
// amplifying speedExposure with those doesn't re-charge the same
// measurement — it charges a genuinely separate risk factor that happens to
// compound with speed.
// ---------------------------------------------------------------------------

/**
 * Upper bound of physically plausible truck speed (mph) — the top anchor of
 * SPEED_EXPOSURE_ANCHORS, not a separate/looser ceiling. A Class 8 truck
 * reading above this is not "an extremely fast truck" for the exposure
 * curve to score higher; it's telemetry to distrust — a GPS/sensor glitch,
 * a unit-conversion bug, or corrupted provider data. Extending the curve
 * further to accommodate ever-larger readings would only ever be validating
 * bad data, never modeling real risk — see isPlausibleSpeed/
 * calculateSpeedExposure, which reject rather than clamp above this line.
 *
 * No rounding tolerance is added above this boundary: Samsara reports
 * speedMilesPerHour directly in mph (see lib/providers/samsara/
 * vehicleStats.ts), not a unit-converted or otherwise-rounded value with an
 * observed tendency to overshoot near real truck speeds. If a real pilot
 * reading is ever observed landing just above 120 due to provider rounding,
 * that observation is the evidence needed to add a small, explicitly
 * documented tolerance — not something to guess at pre-emptively.
 */
export const MAX_PLAUSIBLE_SPEED_MPH = 120;

/**
 * Pure — true for a speed reading trustworthy enough to back a Contextual
 * Speed exposure value. Negative, non-finite (NaN/±Infinity), and
 * implausibly-large (> MAX_PLAUSIBLE_SPEED_MPH) readings are all "invalid
 * telemetry," not "an extremely fast truck," and must never be scored as
 * one — see calculateSpeedExposure and, for pilots, the same check applied
 * upstream in lib/driverContext/assemble.ts::assembleSpeed so the API's own
 * provenance (`contextSources.speed`) marks the reading `unavailable`
 * rather than showing a plausible-looking but bogus "Live" speed.
 */
export function isPlausibleSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed >= 0 && speed <= MAX_PLAUSIBLE_SPEED_MPH;
}

/**
 * Piecewise-linear anchor points [speedMph, exposurePoints] defining the
 * continuous speed-exposure curve — ABSOLUTE KINETIC EXPOSURE from current
 * vehicle speed, not speeding relative to a posted or legal limit (SafeHaul
 * has no posted-speed-limit source; see Part H). Continuous and monotonic by
 * construction: consecutive segments share their boundary value (no jump
 * anywhere, including at the old 70 mph cliff — see calculateSpeedExposure's
 * tests for 69/70/71 mph producing nearby progressive values) and each
 * segment's slope is >= 0. Domain is exactly [0, MAX_PLAUSIBLE_SPEED_MPH] —
 * calculateSpeedExposure rejects anything outside it rather than clamping
 * into it, so this table never needs to describe implausible speeds.
 *   0–20 mph   → 0            parking-lot/yard movement — not highway exposure.
 *                              A floor, not a danger threshold: it's 0 because
 *                              that really is low kinetic exposure, and nothing
 *                              "switches on" at 20 — the next segment starts
 *                              at the same value (0) and rises from there.
 *   20–45 mph  → 0 → 1.5      surface-street/ramp speeds, gently increasing.
 *   45–65 mph  → 1.5 → 4      typical highway cruising, moderate increase.
 *   65–120 mph → 4 → 15       highway and above, steepest slope (0.2 pts/mph).
 * Chosen to keep speedExposure's own worst case (15, at 120 mph) in the same
 * order of magnitude as the other single-factor budgets in this engine
 * (weather max 20, zone max 15) — see MULTIPLIER_CAP's comment for how this
 * interacts with the multiplier.
 */
const SPEED_EXPOSURE_ANCHORS: [speedMph: number, exposure: number][] = [
  [0, 0],
  [20, 0],
  [45, 1.5],
  [65, 4],
  [MAX_PLAUSIBLE_SPEED_MPH, 15],
];

/** Pure — linear interpolation across SPEED_EXPOSURE_ANCHORS. Assumes `speed` is already known-plausible (see calculateSpeedExposure) — never called with a value outside the anchors' domain. */
function interpolateSpeedExposure(speed: number): number {
  for (let i = 1; i < SPEED_EXPOSURE_ANCHORS.length; i++) {
    const [prevSpeed, prevExposure] = SPEED_EXPOSURE_ANCHORS[i - 1];
    const [nextSpeed, nextExposure] = SPEED_EXPOSURE_ANCHORS[i];
    if (speed <= nextSpeed) {
      const span = nextSpeed - prevSpeed;
      const t = span === 0 ? 0 : (speed - prevSpeed) / span;
      return prevExposure + t * (nextExposure - prevExposure);
    }
  }
  return SPEED_EXPOSURE_ANCHORS[SPEED_EXPOSURE_ANCHORS.length - 1][1];
}

/**
 * Continuous, monotonic, bounded speed-exposure signal. Replaces the old
 * `speed > 70 ? ... : 0` cliff (see the Contextual Speed header comment
 * above). An implausible reading — non-finite (NaN/±Infinity), negative, or
 * above MAX_PLAUSIBLE_SPEED_MPH — is REJECTED (treated as no signal, 0
 * exposure), not clamped into range: a truck cannot actually be going
 * 99999 mph, so that reading is corrupted telemetry, and scoring it as "the
 * fastest the model can represent" would penalize a driver for a GPS/
 * provider bug rather than for anything they did. This mirrors
 * isPlausibleSpeed exactly and is intentionally duplicated as a second,
 * defensive layer here (see assembleSpeed in assemble.ts for the first
 * layer, which prevents an implausible pilot reading from ever being
 * labeled `observed`/`fresh` in the first place) — calculateRisk has no way
 * to know whether its caller already validated the input, so it must never
 * assume that.
 *
 * `speed: 0` (RiskInput's default for unavailable speed — see
 * toRiskInput.ts) already resolves to 0 exposure through the curve itself,
 * so "speed unavailable" and "speed genuinely 0" both correctly produce no
 * contextual speed penalty without any special-casing here.
 */
function calculateSpeedExposure(speed: number): number {
  if (!isPlausibleSpeed(speed)) return 0;
  return interpolateSpeedExposure(speed);
}

// Modifier weights — each is "how much this factor can add to the
// multiplier at its own maximum," chosen so no single factor can dominate
// and the documented cap (MULTIPLIER_CAP) is only reached when several
// factors are simultaneously near their worst case:
//   weather 0.50 + zone 0.40 + fatigue 0.30 + behavior 0.25 = 1.45 max combined
//   → multiplier max ≈ 2.45, just under the 2.5 cap (see MULTIPLIER_CAP).
const WEATHER_SPEED_WEIGHT  = 0.5;
const ZONE_SPEED_WEIGHT     = 0.4;
const FATIGUE_SPEED_WEIGHT  = 0.3;
const BEHAVIOR_SPEED_WEIGHT = 0.25; // documented cap on the behavior component specifically

/** HOS hours-on-duty threshold before fatigue starts counting — matches calcFatiguePenalty's own threshold, so "fatigued" means the same thing in both places. */
const FATIGUE_HOS_THRESHOLD = 8;
/** Hours beyond the threshold at which the fatigue modifier reaches its max (8 + 6 = 14h on duty → full weight). */
const FATIGUE_HOS_SPAN = 6;

/**
 * Cap on the total contextMultiplier. Set just above the natural maximum of
 * ~2.45 from the weights above — a safety ceiling against pathological
 * inputs or future weight tuning, not a bound normally reached in practice.
 *
 * Re-validated (not just carried over) after replacing the fixed-threshold
 * base penalty with calculateSpeedExposure: the multiplier's inputs
 * (weather/zone/fatigue/behavior) are independent of how speedExposure
 * itself is computed, so its own natural max is still exactly ~2.45 — this
 * cap did not need to change. What DID change is speedExposure's own worst
 * case, from ~15 (old formula, at 100 mph) to 15 (new curve, at the 120 mph
 * clamp) — coincidentally almost identical, so the worst-case finalPenalty
 * (speedExposure × multiplier ≈ 15 × 2.45 ≈ 37) is essentially unchanged
 * from before this refinement, and remains well short of "overwhelming" a
 * 100-point score on its own (see Part F's calibration table).
 */
const MULTIPLIER_CAP = 2.5;

/**
 * Event types treated as relevant to "recent behavior that makes speeding
 * more dangerous." Deliberately does NOT include "speeding" — a Samsara
 * speeding event and a high real-time GPS speed reading are two
 * observations of essentially the same underlying fact (the vehicle was/is
 * going too fast), so letting a speeding event also amplify speedExposure
 * would charge that one fact twice through two coupled channels. Speeding
 * events keep their own standalone penalty in calcSafetyEventPenalties,
 * unchanged. Harsh braking/turn and distraction are behaviorally
 * independent of current speed (they can happen at any speed), so they
 * remain eligible to amplify speedExposure without re-charging the same
 * measurement.
 *
 * Phase 6A (2026-08-xx) adds "following_distance": tailgating can happen at
 * any speed (even in stop-and-go traffic), but is categorically more
 * dangerous at highway speed — the same "independent of current speed, but
 * compounds with it" shape as the four types already here. Deliberately
 * does NOT add "rolling_stop": a rolling stop is inherently a low-speed-
 * context event (approaching/departing a stop-controlled point), so it
 * doesn't have the "more dangerous when combined with high concurrent
 * speed" story that justifies inclusion here — see the Phase 6A plan
 * (2026-08-xx) for the full reasoning.
 */
const BEHAVIOR_RELEVANT_EVENT_TYPES = new Set([
  "mobile_usage",
  "inattentive_driving",
  "harsh_braking",
  "harsh_turn",
  "following_distance",
]);

function calculateWeatherSpeedModifier(weatherRisk: number, weatherAvailable: boolean): number {
  if (!weatherAvailable) return 0;
  return weatherRisk * WEATHER_SPEED_WEIGHT;
}

function calculateZoneSpeedModifier(zoneRisk: number, zoneRiskAvailable: boolean): number {
  if (!zoneRiskAvailable) return 0;
  return zoneRisk * ZONE_SPEED_WEIGHT;
}

function calculateFatigueSpeedModifier(hosHours: number | null, hosAvailable: boolean): number {
  if (!hosAvailable || hosHours === null || hosHours <= FATIGUE_HOS_THRESHOLD) return 0;
  const normalized = Math.min((hosHours - FATIGUE_HOS_THRESHOLD) / FATIGUE_HOS_SPAN, 1);
  return normalized * FATIGUE_SPEED_WEIGHT;
}

/** Normalized severity-weighted sum of recent relevant events, capped at BEHAVIOR_SPEED_WEIGHT. Always "available" — safetyEvents defaults to [] rather than being unavailable, so there's no missing-context case to guard here. */
function calculateBehaviorSpeedModifier(safetyEvents: RiskInput["safetyEvents"]): number {
  let weight = 0;
  for (const event of safetyEvents) {
    if (!BEHAVIOR_RELEVANT_EVENT_TYPES.has(event.type)) continue;
    weight += (event.severity / 5) * 0.1; // each relevant event contributes up to 0.1 at max severity
  }
  return Math.min(weight, BEHAVIOR_SPEED_WEIGHT);
}

function calculateContextualSpeedPenalty(input: RiskInput): ContextualSpeed {
  const speedExposure = calculateSpeedExposure(input.speed);

  const weatherAvailable  = input.weatherAvailable  ?? true;
  const zoneRiskAvailable = input.zoneRiskAvailable ?? true;
  const hosAvailable      = input.hosAvailable      ?? true;

  const weatherModifier  = calculateWeatherSpeedModifier(input.weatherRisk, weatherAvailable);
  const zoneModifier     = calculateZoneSpeedModifier(input.zoneRisk, zoneRiskAvailable);
  const fatigueModifier  = calculateFatigueSpeedModifier(input.hosHours, hosAvailable);
  const behaviorModifier = calculateBehaviorSpeedModifier(input.safetyEvents);

  const rawMultiplier = 1 + weatherModifier + zoneModifier + fatigueModifier + behaviorModifier;
  const multiplier    = Math.min(rawMultiplier, MULTIPLIER_CAP);

  const missingContext: string[] = [];
  if (!weatherAvailable)  missingContext.push("Weather");
  if (!zoneRiskAvailable) missingContext.push("Zone risk");
  if (!hosAvailable)      missingContext.push("HOS");

  return {
    active: speedExposure > 0,
    speedExposure,
    multiplier,
    finalPenalty: speedExposure * multiplier,
    contextComplete: missingContext.length === 0,
    missingContext,
    components: [
      { key: "weather",  label: "Weather",        modifier: weatherModifier,  included: weatherAvailable },
      { key: "zone",     label: "Risk zone",       modifier: zoneModifier,     included: zoneRiskAvailable },
      { key: "fatigue",  label: "Fatigue",         modifier: fatigueModifier,  included: hosAvailable },
      { key: "behavior", label: "Recent behavior", modifier: behaviorModifier, included: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// Level thresholds
// ---------------------------------------------------------------------------

function resolveLevel(score: number): RiskLevel {
  if (score >= 75) return "LOW";
  if (score >= 50) return "MEDIUM";
  if (score >= 25) return "HIGH";
  return "CRITICAL";
}

// ---------------------------------------------------------------------------
// Explainability — largest-remainder rounding so factors sum to exactly 100
// ---------------------------------------------------------------------------

function buildFactors(displayPenalties: Record<string, number>): RiskFactor[] {
  const totalPenalty = Object.values(displayPenalties).reduce((sum, v) => sum + v, 0);

  if (totalPenalty === 0) return [];

  const labelMap: Record<string, string> = {
    harshBraking:      "Harsh Braking",
    speeding:          "Speeding",
    harshManeuver:     "Harsh Maneuver",
    distraction:       "Distracted Driving",
    mechanical:        "Mechanical Risk",
    fatigue:           "Fatigue",
    weather:           "Weather",
    zone:              "Zone Risk",
    followingDistance: "Following Distance",
    rollingStop:       "Rolling Stop",
  };

  // Compute exact float percentages, keep only non-zero entries
  const entries = Object.entries(displayPenalties)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({
      name:     labelMap[key] ?? key,
      exact:    (value / totalPenalty) * 100,
      floored:  Math.floor((value / totalPenalty) * 100),
      remainder: ((value / totalPenalty) * 100) % 1,
    }));

  // Distribute leftover percentage points to entries with largest fractional remainders
  const distributed = 100 - entries.reduce((sum, e) => sum + e.floored, 0);
  entries.sort((a, b) => b.remainder - a.remainder);
  entries.forEach((e, i) => { e.floored += i < distributed ? 1 : 0; });

  return entries
    .map(({ name, floored }) => ({ name, impact: floored }))
    .sort((a, b) => b.impact - a.impact);
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function buildRecommendations(
  input: RiskInput,
  penalties: Record<string, number>,
  totalPenalty: number
): string[] {
  const recs: string[] = [];

  const fatigueShare = totalPenalty > 0 ? penalties.fatigue / totalPenalty : 0;
  if (fatigueShare >= 0.2 || (input.hosHours !== null && input.hosHours > 10)) {
    recs.push("Consider a rest break soon.");
  }

  if (input.weatherRisk > 0.5) {
    recs.push("Use extra caution due to current weather conditions.");
  }

  // followingDistance included here (Phase 6A) rather than as a separate
  // recommendation string — this message already promises to cover safe
  // following distance, it just wasn't wired to a real following-distance
  // signal until now.
  const speedingPenalty = penalties.speeding + penalties.speed + penalties.followingDistance;
  if (speedingPenalty > 0) {
    recs.push("Reduce speed and maintain a safe following distance.");
  }

  if (input.zoneRisk > 0.5) {
    recs.push("Proceed carefully in the current risk zone.");
  }

  if (penalties.harshBraking > 0) {
    recs.push("Increase following distance to avoid sudden stops.");
  }

  if (penalties.harshManeuver > 0) {
    recs.push("Smooth acceleration and turns improve safety and fuel efficiency.");
  }

  if (penalties.distraction > 0) {
    recs.push("Put the phone away — distracted driving is a leading cause of crashes.");
  }

  if (penalties.mechanical > 0) {
    recs.push("High-speed power loss detected — pull over safely and inspect the vehicle.");
  }

  // Phase 6A — no existing recommendation fits a stop-sign/red-light
  // violation; this string is matched by lib/recommendationDisplay.ts's
  // classifyRecommendation as "Traffic Control", checked before the
  // generic brake/stop branch that would otherwise shadow it.
  if (penalties.rollingStop > 0) {
    recs.push("Come to a complete stop at stop signs and red lights.");
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function calculateRisk(input: RiskInput): RiskOutput {
  const { harshBraking, speeding, harshManeuver, distraction, mechanical, followingDistance, rollingStop } =
    calcSafetyEventPenalties(input.safetyEvents);
  const fatigue = calcFatiguePenalty(input.hosHours);
  const weather = calcWeatherPenalty(input.weatherRisk);
  const zone    = calcZonePenalty(input.zoneRisk);

  const contextualSpeed = calculateContextualSpeedPenalty(input);
  const speed = contextualSpeed.finalPenalty;

  // All raw penalties — used for score calculation and recommendations
  const rawPenalties: Record<string, number> = {
    harshBraking,
    speeding,
    harshManeuver,
    distraction,
    mechanical,
    fatigue,
    weather,
    zone,
    speed,
    followingDistance,
    rollingStop,
  };

  // Display penalties — speeding event + excess speed merged into one
  // "speeding" factor. followingDistance/rollingStop (Phase 6A) get their
  // own bars rather than being merged into an existing bucket — they're
  // distinct hazard categories (close-following risk / intersection
  // compliance), and folding them into "Speeding" or "Harsh Maneuver" would
  // misattribute the cause a driver/reviewer sees in the breakdown.
  const displayPenalties: Record<string, number> = {
    harshBraking,
    speeding: speeding + speed,
    harshManeuver,
    distraction,
    mechanical,
    fatigue,
    weather,
    zone,
    followingDistance,
    rollingStop,
  };

  const totalPenalty = Object.values(rawPenalties).reduce((sum, v) => sum + v, 0);
  const rawScore     = 100 - totalPenalty;
  const score        = Math.min(100, Math.max(0, Math.round(rawScore)));

  return {
    score,
    level:           resolveLevel(score),
    trend:           "STABLE",
    factors:         buildFactors(displayPenalties),
    recommendations: buildRecommendations(input, rawPenalties, totalPenalty),
    contextualSpeed,
  };
}

/**
 * lib/providers/zones/zoneData.ts
 *
 * Phase 3 — Real Zone Risk. A v1 curated seed set of named, real-world
 * freight corridors/hubs known for elevated heavy-vehicle risk (port
 * terminal congestion, dense interstate merges, major intermodal
 * interchanges). This is a starting dataset, not a claim of comprehensive
 * or statistically derived coverage — see the Phase 3 investigation report
 * for why a bundled local dataset was chosen over a live third-party API,
 * and NHTSA FARS/FHWA HPMS as the natural richer-data upgrade path if
 * nationwide coverage is needed later.
 *
 * v2 schema (zone-model expansion, 2026-08-04): adds `type`, `explanation`,
 * and `source` to each zone so the dataset is self-documenting — every
 * entry states what kind of hazard it represents, what a driver/reviewer
 * should be told about it, and where its risk weight came from. This is a
 * SCHEMA change only: the ten entries below are the exact same ten
 * locations/coordinates/radii/risk scores from the original v1 dataset,
 * just with structure promoted out of what were previously inline `//`
 * comments. No new locations were added in this pass — see the zone-model
 * expansion investigation for why: without a second reliable, documented
 * source of curated zone definitions in this repository, adding more pins
 * would mean either guessing at coordinates (a fabricated-looking "data"
 * problem, the opposite of this file's whole purpose) or cherry-picking
 * locations to cover a specific driver's current position (which would
 * make the dataset dishonest in the other direction). Real dataset growth
 * is left for a separate phase, backed by an actual source (e.g. FARS/HPMS
 * corridor data, or a licensed geofencing feed).
 *
 * Each zone is a simple circle (center + radius), not a precise legal
 * boundary — deliberately simple so matching stays a pure, auditable
 * distance calculation (see zoneRisk.ts) with no new geospatial dependency.
 * A real GPS position outside every zone's radius is a legitimate, real
 * "outside monitored risk zones" reading (see ZoneAvailability in
 * lib/driverContext/types.ts) — never a fabricated default score.
 *
 * `corridor` is a reserved, not-yet-implemented extension point for a
 * future line/polyline geometry (e.g. "the next 50 miles of I-95
 * northbound"), called out explicitly in Part 2's design brief as a shape
 * the schema should be able to hold. lib/providers/zones/zoneRisk.ts's
 * matchZone only implements circle matching today and does not read this
 * field at all — it exists purely so the schema doesn't need a second
 * breaking change once corridor matching is actually built. No entry below
 * sets it yet; do not populate it without also implementing corridor
 * matching, or it will silently have no effect.
 */

/**
 * Broad hazard category for a curated zone — lets a driver/reviewer/auditor
 * understand at a glance what kind of risk a match represents, independent
 * of the specific `explanation` text or numeric `riskScore`.
 */
export type ZoneType =
  | "freight_hub"        // intermodal rail/truck/air freight transfer hub
  | "port"                // container/marine terminal and its drayage approaches
  | "major_interchange"   // dense multi-interstate interchange or beltway
  | "high_risk_corridor"  // a specific stretch of roadway with elevated risk
  | "urban_congestion";   // dense urban interstate segment (frequent lane drops/merges)

export interface ZoneCorridorPoint {
  latitude: number;
  longitude: number;
}

/**
 * Reserved line/polyline geometry for a future corridor-shaped zone (as
 * opposed to today's circle-only zones). Not consumed by matchZone yet —
 * see the file header. Modeled now so the schema doesn't need a second
 * breaking change when corridor matching is actually implemented.
 */
export interface ZoneCorridorGeometry {
  points: ZoneCorridorPoint[];
  widthMiles: number;
}

export interface ZoneDefinition {
  /** Stable identifier — used as the audit trail key (DriverContext's ZoneDetail.matchedZoneId) and must never be reused for a different location. */
  id: string;
  /** Human-readable name shown to drivers/fleet managers/auditors. */
  name: string;
  /** Hazard category — see ZoneType. Optional only so minimal synthetic fixtures (e.g. unit tests exercising pure geometry matching) aren't forced to supply a category that's irrelevant to what they're testing; every real dataset entry below sets it. */
  type?: ZoneType;
  /** Circle-geometry center (degrees). Every zone today is a circle — see `corridor` for the reserved alternative. */
  latitude: number;
  longitude: number;
  /** Circle radius in miles — the effective monitored area around (latitude, longitude). */
  radiusMiles: number;
  /** Reserved, not-yet-matched line/corridor geometry — see ZoneCorridorGeometry and the file header. */
  corridor?: ZoneCorridorGeometry;
  /** Deterministic 0–1 risk weight fed directly into the risk engine's zone penalty/modifier — see lib/riskEngine.ts's calcZonePenalty/calculateZoneSpeedModifier. Not a probability; a hand-curated relative severity ranking across this dataset. */
  riskScore: number;
  /** Driver/fleet-manager/auditor-facing sentence explaining *why* this location carries elevated risk. Optional for the same reason as `type` (test fixtures); every real entry below sets it. */
  explanation?: string;
  /** Provenance/documentation note — where the classification and risk weight came from, and when it was last reviewed. Optional for the same reason as `type`. */
  source?: string;
}

const CURATED_DATASET_NOTE =
  "SafeHaul v1 curated seed set — hand-selected major US freight hubs/ports/interchanges, not a statistically derived or nationwide-coverage dataset. Risk scores are relative severity rankings assigned during initial curation (2026-07), not measured incident rates. See zoneData.ts file header for the FARS/HPMS upgrade path.";

export const ZONE_DATA: ZoneDefinition[] = [
  {
    id: "port-houston-ship-channel",
    name: "Port of Houston Ship Channel, TX",
    type: "port",
    latitude: 29.7355,
    longitude: -95.0895,
    radiusMiles: 8,
    riskScore: 0.55,
    explanation: "Major container/petrochemical port with heavy chassis and drayage congestion around the terminal approaches.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "port-long-beach-la",
    name: "Port of Long Beach / Los Angeles, CA",
    type: "port",
    latitude: 33.754,
    longitude: -118.216,
    radiusMiles: 10,
    riskScore: 0.6,
    explanation: "Busiest US container port complex, with severe drayage congestion on surrounding surface streets and freeways.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "port-newark-elizabeth",
    name: "Port Newark–Elizabeth Marine Terminal, NJ",
    type: "port",
    latitude: 40.6895,
    longitude: -74.1745,
    radiusMiles: 8,
    riskScore: 0.55,
    explanation: "Major East Coast container port with dense surrounding interstate merges feeding the terminal.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "i95-philadelphia-corridor",
    name: "I-95 Philadelphia / Delaware River Corridor, PA",
    type: "urban_congestion",
    latitude: 39.9526,
    longitude: -75.1652,
    radiusMiles: 15,
    riskScore: 0.45,
    explanation: "Dense urban interstate segment with frequent lane drops and merge points.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "chicago-i294-i90-intermodal",
    name: "Chicago I-294/I-90 Intermodal Corridor, IL",
    type: "freight_hub",
    latitude: 41.8781,
    longitude: -87.6298,
    radiusMiles: 12,
    riskScore: 0.5,
    explanation: "Largest US intermodal rail-truck hub, with heavy cross-town freight volume.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "atlanta-i285-perimeter",
    name: "Atlanta I-285 Perimeter, GA",
    type: "major_interchange",
    latitude: 33.749,
    longitude: -84.388,
    radiusMiles: 12,
    riskScore: 0.45,
    explanation: "High-volume beltway with dense merge/weave sections.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "dfw-i35w-freight-corridor",
    name: "Dallas–Fort Worth I-35W Freight Corridor, TX",
    type: "high_risk_corridor",
    latitude: 32.7555,
    longitude: -97.3308,
    radiusMiles: 12,
    riskScore: 0.4,
    explanation: "Major north-south freight artery running through a dense metro area.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "memphis-i40-i55-interchange",
    name: "Memphis I-40/I-55 Freight Interchange, TN",
    type: "freight_hub",
    latitude: 35.1495,
    longitude: -90.049,
    radiusMiles: 10,
    riskScore: 0.5,
    explanation: "Major air/rail/truck freight hub with high interchange complexity.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "kansas-city-i70-i35-interchange",
    name: "Kansas City I-70/I-35 Interchange, MO",
    type: "major_interchange",
    latitude: 39.0997,
    longitude: -94.5786,
    radiusMiles: 10,
    riskScore: 0.4,
    explanation: "Major cross-country freight interchange.",
    source: CURATED_DATASET_NOTE,
  },
  {
    id: "louisville-spaghetti-junction",
    name: "Louisville I-64/I-65/I-71 Interchange, KY",
    type: "major_interchange",
    latitude: 38.2527,
    longitude: -85.7585,
    radiusMiles: 10,
    riskScore: 0.45,
    explanation: "Major overnight air-freight hub with a complex multi-interstate interchange.",
    source: CURATED_DATASET_NOTE,
  },
];

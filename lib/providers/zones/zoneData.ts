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
 * Each zone is a simple circle (center + radius), not a precise legal
 * boundary — deliberately simple so matching stays a pure, auditable
 * distance calculation (see zoneRisk.ts) with no new geospatial dependency.
 * A real GPS position outside every zone's radius is a legitimate
 * "unavailable" result, never a fabricated default score.
 */

export interface ZoneDefinition {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMiles: number;
  riskScore: number; // 0–1
}

export const ZONE_DATA: ZoneDefinition[] = [
  {
    id: "port-houston-ship-channel",
    name: "Port of Houston Ship Channel, TX",
    latitude: 29.7355,
    longitude: -95.0895,
    radiusMiles: 8,
    riskScore: 0.55, // major container/petrochemical port — heavy chassis/drayage congestion
  },
  {
    id: "port-long-beach-la",
    name: "Port of Long Beach / Los Angeles, CA",
    latitude: 33.754,
    longitude: -118.216,
    radiusMiles: 10,
    riskScore: 0.6, // busiest US container port complex — severe drayage congestion
  },
  {
    id: "port-newark-elizabeth",
    name: "Port Newark–Elizabeth Marine Terminal, NJ",
    latitude: 40.6895,
    longitude: -74.1745,
    radiusMiles: 8,
    riskScore: 0.55, // major East Coast container port, dense surrounding interstate merges
  },
  {
    id: "i95-philadelphia-corridor",
    name: "I-95 Philadelphia / Delaware River Corridor, PA",
    latitude: 39.9526,
    longitude: -75.1652,
    radiusMiles: 15,
    riskScore: 0.45, // dense urban interstate, frequent lane drops and merges
  },
  {
    id: "chicago-i294-i90-intermodal",
    name: "Chicago I-294/I-90 Intermodal Corridor, IL",
    latitude: 41.8781,
    longitude: -87.6298,
    radiusMiles: 12,
    riskScore: 0.5, // largest US intermodal rail-truck hub, heavy cross-town freight volume
  },
  {
    id: "atlanta-i285-perimeter",
    name: "Atlanta I-285 Perimeter, GA",
    latitude: 33.749,
    longitude: -84.388,
    radiusMiles: 12,
    riskScore: 0.45, // high-volume beltway, dense merge/weave sections
  },
  {
    id: "dfw-i35w-freight-corridor",
    name: "Dallas–Fort Worth I-35W Freight Corridor, TX",
    latitude: 32.7555,
    longitude: -97.3308,
    radiusMiles: 12,
    riskScore: 0.4, // major north-south freight artery through a dense metro
  },
  {
    id: "memphis-i40-i55-interchange",
    name: "Memphis I-40/I-55 Freight Interchange, TN",
    latitude: 35.1495,
    longitude: -90.049,
    radiusMiles: 10,
    riskScore: 0.5, // major air/rail/truck freight hub, high interchange complexity
  },
  {
    id: "kansas-city-i70-i35-interchange",
    name: "Kansas City I-70/I-35 Interchange, MO",
    latitude: 39.0997,
    longitude: -94.5786,
    radiusMiles: 10,
    riskScore: 0.4, // major cross-country freight interchange
  },
  {
    id: "louisville-spaghetti-junction",
    name: "Louisville I-64/I-65/I-71 Interchange, KY",
    latitude: 38.2527,
    longitude: -85.7585,
    radiusMiles: 10,
    riskScore: 0.45, // major overnight air-freight hub, complex multi-interstate interchange
  },
];

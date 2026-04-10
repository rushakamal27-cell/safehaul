/**
 * lib/mockScenarios.ts
 *
 * Realistic driver scenario datasets for SafeHaul mock mode.
 * Each scenario covers a distinct risk profile that exercises a different
 * branch of the risk engine, so the app can demonstrate all four risk levels.
 *
 * Scenario selection (in priority order):
 *   1. MOCK_SCENARIO=<index> env var — force a specific scenario (dev/testing)
 *   2. Deterministic hash of driverId — consistent per driver, varied across drivers
 *
 * Risk level each scenario produces (verified against riskEngine.ts thresholds):
 *   0  CLEAN_RUN           → LOW      (~96)
 *   1  ADVERSE_WEATHER     → MEDIUM   (~72)
 *   2  FATIGUE_AND_SPEED   → HIGH     (~48)
 *   3  CRITICAL_ALL_FACTORS → CRITICAL (~13)
 */

export interface ScenarioSafetyEvent {
  type: string;      // "harsh_braking" | "speeding"
  severity: number;  // 1–5
  timestamp: string; // ISO 8601
}

export interface MockScenario {
  label: string;
  description: string;
  // HOS
  hosHoursUsed: number;
  // Vehicle / GPS
  currentSpeed: number;    // mph
  lat: number;
  lng: number;
  locationLabel: string;   // human-readable reverse-geocode result
  zoneName: string;        // named operational zone, empty string if none
  // Safety events
  safetyEvents: ScenarioSafetyEvent[];
  // Environment
  weatherRisk: number;     // 0–1
  zoneRisk: number;        // 0–1
  // Trip summary
  milesDrivenToday: number;
  checksPassed: number;    // DVIR checks with no defects
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Scenario 0 — CLEAN_RUN (LOW, ~96)
// Fresh driver, clear weather, safe speed, no events.
// ---------------------------------------------------------------------------
const CLEAN_RUN: MockScenario = {
  label: "CLEAN_RUN",
  description: "Early shift, clear conditions, no violations.",
  hosHoursUsed: 3.5,
  currentSpeed: 62,
  lat: 33.749,
  lng: -84.388,
  locationLabel: "I-285 W · Exit 31, Fulton County, GA",
  zoneName: "",
  safetyEvents: [],
  weatherRisk: 0.1,
  zoneRisk: 0.1,
  milesDrivenToday: 156,
  checksPassed: 5,
};

// ---------------------------------------------------------------------------
// Scenario 1 — ADVERSE_WEATHER (MEDIUM, ~72)
// Rested driver caught in storm conditions and a high-risk corridor.
// ---------------------------------------------------------------------------
const ADVERSE_WEATHER: MockScenario = {
  label: "ADVERSE_WEATHER",
  description: "Thunderstorm and high-risk corridor — driver is rested.",
  hosHoursUsed: 6.0,
  currentSpeed: 58,
  lat: 30.332,
  lng: -81.655,
  locationLabel: "I-95 N · Mile Marker 362, Duval County, FL",
  zoneName: "Jacksonville High-Incident Corridor",
  safetyEvents: [],
  weatherRisk: 0.9,
  zoneRisk: 0.7,
  milesDrivenToday: 203,
  checksPassed: 4,
};

// ---------------------------------------------------------------------------
// Scenario 2 — FATIGUE_AND_SPEED (HIGH, ~48)
// Near-limit HOS, multiple speeding and braking events, high speed.
// ---------------------------------------------------------------------------
const FATIGUE_AND_SPEED: MockScenario = {
  label: "FATIGUE_AND_SPEED",
  description: "Long shift, repeat speeding events, approaching HOS limit.",
  hosHoursUsed: 11.5,
  currentSpeed: 82,
  lat: 32.0835,
  lng: -81.0998,
  locationLabel: "I-16 W · Mile Marker 52, Chatham County, GA",
  zoneName: "Port of Savannah — Terminal Gate 7",
  safetyEvents: [
    { type: "speeding",      severity: 4, timestamp: now() },
    { type: "speeding",      severity: 3, timestamp: now() },
    { type: "harsh_braking", severity: 3, timestamp: now() },
  ],
  weatherRisk: 0.3,
  zoneRisk: 0.4,
  milesDrivenToday: 487,
  checksPassed: 2,
};

// ---------------------------------------------------------------------------
// Scenario 3 — CRITICAL_ALL_FACTORS (CRITICAL, ~13)
// All risk factors elevated simultaneously — intervention required.
// ---------------------------------------------------------------------------
const CRITICAL_ALL_FACTORS: MockScenario = {
  label: "CRITICAL_ALL_FACTORS",
  description: "All risk factors elevated simultaneously — immediate intervention required.",
  hosHoursUsed: 12.5,
  currentSpeed: 88,
  lat: 29.951,
  lng: -90.071,
  locationLabel: "I-10 E · Mile Marker 238, Orleans Parish, LA",
  zoneName: "New Orleans Industrial Canal — High-Risk Zone",
  safetyEvents: [
    { type: "speeding",      severity: 5, timestamp: now() },
    { type: "speeding",      severity: 4, timestamp: now() },
    { type: "harsh_braking", severity: 4, timestamp: now() },
    { type: "harsh_braking", severity: 3, timestamp: now() },
  ],
  weatherRisk: 0.8,
  zoneRisk: 0.8,
  milesDrivenToday: 621,
  checksPassed: 1,
};

export const SCENARIOS: MockScenario[] = [
  CLEAN_RUN,            // index 0 → LOW
  ADVERSE_WEATHER,      // index 1 → MEDIUM
  FATIGUE_AND_SPEED,    // index 2 → HIGH
  CRITICAL_ALL_FACTORS, // index 3 → CRITICAL
];

/**
 * Selects a scenario for a given driverId.
 * Same driverId always returns the same scenario across requests.
 * Set MOCK_SCENARIO=<0–3> in .env to force a specific scenario for all drivers.
 */
export function getScenarioForDriver(driverId: string): MockScenario {
  const override = process.env.MOCK_SCENARIO;
  if (override !== undefined) {
    const idx = parseInt(override, 10);
    if (!isNaN(idx) && idx >= 0 && idx < SCENARIOS.length) return SCENARIOS[idx];
  }
  const hash = driverId.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return SCENARIOS[hash % SCENARIOS.length];
}

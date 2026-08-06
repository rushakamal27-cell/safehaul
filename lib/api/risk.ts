/**
 * lib/api/risk.ts
 *
 * The true response contract for GET /api/risk (N4, Phase 5, 2026-08-05).
 * Both app/api/risk/route.ts (server) and
 * components/screens/DashboardScreen.tsx (client) import from here instead
 * of each independently declaring their own version of this shape — the
 * exact drift this fixes: DashboardScreen.tsx's old hand-duplicated
 * `RiskResponse`/`LiveData`/`TodaySummary` types had already gone out of
 * sync with what the route actually returns (they omitted `location`,
 * `weather`, `input`, and `liveData.syncStatus`, all of which are present
 * in the real JSON response but were invisible to the frontend's type
 * checker).
 *
 * Deliberately imports ONLY from other zero-runtime-dependency type
 * modules (lib/driverContext/types.ts, lib/riskEngine.ts — both pure
 * type/interface declarations with no imports of their own, verified when
 * this file was created) — never from app/api/risk/route.ts itself, or
 * lib/driverContext/assemble.ts, or any module with server-only I/O
 * (prisma, fetch, provider HTTP clients). That's what makes this file safe
 * to import directly into a "use client" component without pulling server
 * code into the client bundle — see docs/data-freshness.md's sibling
 * concern for freshness vocabularies; this is the same "one shared,
 * dependency-free source of truth" pattern applied to response shapes.
 */

import type { RiskInput, RiskOutput } from "@/lib/riskEngine";
import type {
  ContextSources,
  ContextStatus,
  HosDetail,
  VehicleLocation,
  WeatherDetail,
  ZoneDetail,
} from "@/lib/driverContext/types";
import type { ApiErrorResponse } from "./common";

/**
 * Mirrors lib/providers/samsara/onDemandSync.ts's OnDemandSyncStatus —
 * redeclared here (not imported) because that module is server-only
 * (touches prisma). Structural typing makes the two interchangeable at the
 * type-checker level without a runtime dependency.
 */
export type RiskApiSyncStatus = "fresh" | "refreshed" | "refresh_failed" | "sync_in_progress";

/** Mirrors lib/driverContext/assemble.ts's DriverContextLiveData — see RiskApiSyncStatus's comment for why this is redeclared, not imported. */
export interface RiskApiLiveData {
  provider: string;
  lastEventType: string | null;
  lastEventTimestamp: string | null;
  lastSyncTime: string | null;
  driverEventCount24h: number;
  syncStatus: RiskApiSyncStatus;
}

export interface RiskApiTodaySummary {
  checksPassed: number;
  milesDriven: number | null;
  alertsActive: number;
  timezone: string;
  dataStatus: {
    checks: "available" | "unavailable";
    mileage: "available" | "unavailable";
    alerts: "available" | "unavailable";
  };
}

/**
 * Plain count/total of how many of DriverContext's six tracked fields are
 * currently live (N5, Phase 5, 2026-08-05) — see
 * lib/driverContext/contextStatus.ts's deriveDataCompleteness for the full
 * derivation and its documented caveats (total is 6, not the same 5-field
 * set contextStatus itself uses; never weighted; demo never counts).
 * Deliberately NOT named/framed as confidence, prediction confidence,
 * accuracy, reliability, or certainty — it measures data completeness
 * only. UI must render it with neutral wording (e.g. "Live inputs: 4 of
 * 6"), never alongside those words.
 */
export interface RiskApiDataCompleteness {
  count: number;
  total: number;
}

/**
 * The full success shape returned by GET /api/risk — see
 * app/api/risk/route.ts's buildRiskResponse for the construction site this
 * mirrors field-for-field. Field-level doc comments live there, not here,
 * to avoid two copies of the same explanation drifting apart; this file is
 * the shape, route.ts's inline comments are the rationale.
 */
export interface RiskApiResponse {
  driverId: string;
  timestamp: string;
  dataSource: "real" | "mock";
  contextStatus: ContextStatus;
  dataCompleteness: RiskApiDataCompleteness;
  contextSources: ContextSources;
  liveData: RiskApiLiveData | null;
  hos: HosDetail;
  location: VehicleLocation;
  weather: WeatherDetail;
  zone: ZoneDetail;
  todaySummary: RiskApiTodaySummary;
  input: RiskInput;
  result: RiskOutput;
}

export type { ApiErrorResponse };

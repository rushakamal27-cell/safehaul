/**
 * lib/api/common.ts
 *
 * Shared, pure API-contract types safe to import from BOTH server route
 * handlers (app/api/**\/route.ts) and client components — zero runtime
 * imports, zero server-only dependencies (no prisma, no fetch, no provider
 * clients). Part of N4 (Phase 5, 2026-08-05) — see lib/api/risk.ts and
 * lib/api/location.ts for the per-route response contracts that build on
 * this.
 */

/**
 * The consistent error envelope SafeHaul API routes return on an
 * unexpected failure (N3, Phase 5, 2026-08-05) — see app/api/risk/route.ts
 * and app/api/location/route.ts for the catch blocks that construct this.
 * `error` is always a safe, user-facing message — never a stack trace, DB
 * error detail, provider payload, or personal identifier; those are logged
 * server-side only (console.error in each route's catch block), never sent
 * to the client.
 */
export interface ApiErrorResponse {
  error: string;
}

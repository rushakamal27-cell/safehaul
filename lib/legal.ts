/**
 * lib/legal.ts
 *
 * Phase 4.6B — Legal Onboarding Foundation.
 *
 * A driver's onboarding is "complete" when they hold an acceptance row for
 * every currently-active LegalDocument. That check never references a
 * specific version number, so publishing Terms v2 and activating it (see
 * activateLegalDocument) automatically re-opens the gate for every driver
 * who only accepted v1 — no code changes required (Part G).
 *
 * All DB access goes through small injectable client interfaces (mirroring
 * lib/driverIdentity.ts / lib/providers/samsara/syncSafetyEvents.ts) so the
 * business logic is testable with in-memory fakes, never a real database.
 */

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed LegalDocument.type values. Plain strings (not a DB enum), consistent
 *  with how `provider`/`source`/`overallResult` are modeled elsewhere in this schema. */
export const LEGAL_DOCUMENT_TYPES = ["terms_of_use", "privacy_notice"] as const;
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export interface LegalDocumentRow {
  id: string;
  type: string;
  version: number;
  title: string;
  content: string;
  effectiveAt: Date;
  isActive: boolean;
}

export interface LegalDocumentSummary {
  id: string;
  type: string;
  version: number;
  title: string;
  effectiveAt: string; // ISO
}

export interface LegalStatus {
  /** All currently-active documents (one per type). */
  documents: LegalDocumentSummary[];
  /** Active documents this driver has NOT yet accepted — what the gate should show. */
  pending: LegalDocumentSummary[];
  onboardingComplete: boolean;
}

function toSummary(doc: LegalDocumentRow): LegalDocumentSummary {
  return {
    id: doc.id,
    type: doc.type,
    version: doc.version,
    title: doc.title,
    effectiveAt: doc.effectiveAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Errors — thrown by acceptLegalDocument, mapped to HTTP status by the route
// ---------------------------------------------------------------------------

export class LegalDocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`LegalDocument not found: ${documentId}`);
    this.name = "LegalDocumentNotFoundError";
  }
}

export class LegalDocumentInactiveError extends Error {
  constructor(documentId: string) {
    super(`LegalDocument is not active (superseded or unpublished): ${documentId}`);
    this.name = "LegalDocumentInactiveError";
  }
}

// ---------------------------------------------------------------------------
// Injectable DB client seams
// ---------------------------------------------------------------------------

export interface LegalDocumentClient {
  findMany(args: { where: Record<string, unknown> }): Promise<LegalDocumentRow[]>;
  findUnique(args: { where: { id: string } }): Promise<LegalDocumentRow | null>;
  update(args: { where: { id: string }; data: { isActive: boolean } }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: { isActive: boolean } }): Promise<unknown>;
}

export interface LegalAcceptanceRow {
  legalDocumentId: string;
}

export interface AcceptanceCreateData {
  driverId: string;
  legalDocumentId: string;
  telegramUserId: string;
  userAgent: string | null;
  ipAddress: string | null;
}

export interface LegalAcceptanceClient {
  findMany(args: {
    where: { driverId: string; legalDocumentId: { in: string[] } };
  }): Promise<LegalAcceptanceRow[]>;
  create(args: { data: AcceptanceCreateData }): Promise<{ id: string }>;
}

export interface LegalDeps {
  documentClient?: LegalDocumentClient;
  acceptanceClient?: LegalAcceptanceClient;
  runTransaction?: (ops: Promise<unknown>[]) => Promise<unknown>;
}

function resolveDeps(deps: LegalDeps) {
  return {
    documentClient:
      deps.documentClient ?? (prisma.legalDocument as unknown as LegalDocumentClient),
    acceptanceClient:
      deps.acceptanceClient ?? (prisma.legalAcceptance as unknown as LegalAcceptanceClient),
    runTransaction:
      deps.runTransaction ?? ((ops: Promise<unknown>[]) => prisma.$transaction(ops as any)),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Returns all currently-active documents (normally one per type). */
export async function getActiveLegalDocuments(deps: LegalDeps = {}): Promise<LegalDocumentRow[]> {
  const { documentClient } = resolveDeps(deps);
  return documentClient.findMany({ where: { isActive: true } });
}

/**
 * Computes a driver's legal-acceptance status by comparing currently-active
 * documents against the driver's acceptance rows for those exact document
 * IDs. Never looks at version numbers directly — a new active version simply
 * has a new ID with no matching acceptance row yet.
 */
export async function getLegalStatus(driverId: string, deps: LegalDeps = {}): Promise<LegalStatus> {
  const { acceptanceClient } = resolveDeps(deps);
  const active = await getActiveLegalDocuments(deps);

  if (active.length === 0) {
    return { documents: [], pending: [], onboardingComplete: true };
  }

  const acceptances = await acceptanceClient.findMany({
    where: { driverId, legalDocumentId: { in: active.map((d) => d.id) } },
  });
  const acceptedIds = new Set(acceptances.map((a) => a.legalDocumentId));

  const documents = active.map(toSummary);
  const pending = active.filter((d) => !acceptedIds.has(d.id)).map(toSummary);

  return { documents, pending, onboardingComplete: pending.length === 0 };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface AcceptLegalDocumentParams {
  driverId: string;
  documentId: string;
  telegramUserId: string;
  userAgent: string | null;
  ipAddress: string | null;
}

export interface AcceptLegalDocumentResult {
  accepted: true;
  alreadyAccepted: boolean;
  documentId: string;
}

/**
 * Records a driver's acceptance of a specific document version. Idempotent:
 * a second call for the same (driverId, documentId) pair is a no-op that
 * still reports success, via the same optimistic-create + unique-constraint
 * fallback pattern used elsewhere in this codebase (e.g. webhook dedup).
 *
 * Throws LegalDocumentNotFoundError / LegalDocumentInactiveError for invalid
 * requests — callers (the API route) map these to 404/409.
 */
export async function acceptLegalDocument(
  params: AcceptLegalDocumentParams,
  deps: LegalDeps = {}
): Promise<AcceptLegalDocumentResult> {
  const { documentClient, acceptanceClient } = resolveDeps(deps);

  const document = await documentClient.findUnique({ where: { id: params.documentId } });
  if (!document) throw new LegalDocumentNotFoundError(params.documentId);
  if (!document.isActive) throw new LegalDocumentInactiveError(params.documentId);

  try {
    await acceptanceClient.create({
      data: {
        driverId: params.driverId,
        legalDocumentId: params.documentId,
        telegramUserId: params.telegramUserId,
        userAgent: params.userAgent,
        ipAddress: params.ipAddress,
      },
    });
    return { accepted: true, alreadyAccepted: false, documentId: params.documentId };
  } catch (err: any) {
    // P2002 = unique constraint violation on (driverId, legalDocumentId) — already accepted.
    if (err?.code === "P2002") {
      return { accepted: true, alreadyAccepted: true, documentId: params.documentId };
    }
    throw err;
  }
}

/**
 * Activates one document version and deactivates every other version of the
 * same type, atomically. This is how "only one active version per type" is
 * enforced (application-level — see the schema comment on LegalDocument).
 * Used by prisma/seed.ts; not exposed via an API route in this phase.
 */
export async function activateLegalDocument(documentId: string, deps: LegalDeps = {}): Promise<void> {
  const { documentClient, runTransaction } = resolveDeps(deps);

  const document = await documentClient.findUnique({ where: { id: documentId } });
  if (!document) throw new LegalDocumentNotFoundError(documentId);

  await runTransaction([
    documentClient.updateMany({
      where: { type: document.type, isActive: true },
      data: { isActive: false },
    }),
    documentClient.update({ where: { id: documentId }, data: { isActive: true } }),
  ]);
}

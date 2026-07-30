import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getLegalStatus,
  acceptLegalDocument,
  activateLegalDocument,
  LegalDocumentNotFoundError,
  LegalDocumentInactiveError,
  type LegalDocumentRow,
  type LegalAcceptanceRow,
  type LegalDeps,
} from "../legal";

// ---------------------------------------------------------------------------
// In-memory fakes — no real prisma/database access, mirroring the pattern
// used in lib/__tests__/driverIdentity.test.ts.
// ---------------------------------------------------------------------------

function makeFakes(initialDocs: LegalDocumentRow[] = []) {
  const docs = new Map<string, LegalDocumentRow>(initialDocs.map((d) => [d.id, d]));
  const acceptances: { driverId: string; legalDocumentId: string }[] = [];

  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => (row as any)[key] === value);
  }

  const deps: LegalDeps = {
    documentClient: {
      findMany: async ({ where }) =>
        Array.from(docs.values()).filter((d) => matches(d as any, where)),
      findUnique: async ({ where }) => docs.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const row = docs.get(where.id);
        if (row) row.isActive = data.isActive;
        return {};
      },
      updateMany: async ({ where, data }) => {
        for (const row of Array.from(docs.values())) {
          if (matches(row as any, where)) row.isActive = data.isActive;
        }
        return {};
      },
    },
    acceptanceClient: {
      findMany: async ({ where }): Promise<LegalAcceptanceRow[]> =>
        acceptances
          .filter((a) => a.driverId === where.driverId && where.legalDocumentId.in.includes(a.legalDocumentId))
          .map((a) => ({ legalDocumentId: a.legalDocumentId })),
      create: async ({ data }) => {
        const dup = acceptances.some(
          (a) => a.driverId === data.driverId && a.legalDocumentId === data.legalDocumentId
        );
        if (dup) {
          const err: any = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        acceptances.push({ driverId: data.driverId, legalDocumentId: data.legalDocumentId });
        return { id: `acc_${acceptances.length}` };
      },
    },
    runTransaction: async (ops) => Promise.all(ops),
  };

  return { deps, docs, acceptances };
}

function doc(overrides: Partial<LegalDocumentRow>): LegalDocumentRow {
  return {
    id: "doc_1",
    type: "terms_of_use",
    version: 1,
    title: "SafeHaul Terms of Use",
    content: "placeholder",
    effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getLegalStatus
// ---------------------------------------------------------------------------

describe("getLegalStatus", () => {
  test("first-time driver: no acceptances -> all active documents are pending, onboarding incomplete", async () => {
    const terms = doc({ id: "terms_v1", type: "terms_of_use", version: 1 });
    const privacy = doc({ id: "privacy_v1", type: "privacy_notice", version: 1, title: "SafeHaul Privacy Notice" });
    const { deps } = makeFakes([terms, privacy]);

    const status = await getLegalStatus("drv_new", deps);
    assert.equal(status.onboardingComplete, false);
    assert.equal(status.pending.length, 2);
    assert.deepEqual(status.pending.map((d) => d.id).sort(), ["privacy_v1", "terms_v1"]);
  });

  test("returning driver: has accepted every active document -> onboarding complete, nothing pending", async () => {
    const terms = doc({ id: "terms_v1" });
    const { deps } = makeFakes([terms]);
    await acceptLegalDocument(
      { driverId: "drv_1", documentId: "terms_v1", telegramUserId: "tg_1", userAgent: null, ipAddress: null },
      deps
    );

    const status = await getLegalStatus("drv_1", deps);
    assert.equal(status.onboardingComplete, true);
    assert.deepEqual(status.pending, []);
  });

  test("inactive documents are never included in status, pending, or the active count", async () => {
    const activeTerms = doc({ id: "terms_v2", version: 2, isActive: true });
    const inactiveTerms = doc({ id: "terms_v1", version: 1, isActive: false });
    const { deps } = makeFakes([activeTerms, inactiveTerms]);

    const status = await getLegalStatus("drv_1", deps);
    assert.deepEqual(status.documents.map((d) => d.id), ["terms_v2"]);
    assert.deepEqual(status.pending.map((d) => d.id), ["terms_v2"]);
  });

  test("no active documents configured at all -> onboarding trivially complete", async () => {
    const { deps } = makeFakes([]);
    const status = await getLegalStatus("drv_1", deps);
    assert.equal(status.onboardingComplete, true);
  });

  test("new document version: driver who accepted v1 is pending again after v2 is activated", async () => {
    const v1 = doc({ id: "terms_v1", version: 1, isActive: true });
    const { deps, docs } = makeFakes([v1]);

    await acceptLegalDocument(
      { driverId: "drv_1", documentId: "terms_v1", telegramUserId: "tg_1", userAgent: null, ipAddress: null },
      deps
    );
    let status = await getLegalStatus("drv_1", deps);
    assert.equal(status.onboardingComplete, true);

    // Publish + activate v2 — no code changes required for the gate to reopen.
    docs.set("terms_v2", doc({ id: "terms_v2", version: 2, isActive: false }));
    await activateLegalDocument("terms_v2", deps);

    status = await getLegalStatus("drv_1", deps);
    assert.equal(status.onboardingComplete, false);
    assert.deepEqual(status.pending.map((d) => d.id), ["terms_v2"]);
  });
});

// ---------------------------------------------------------------------------
// acceptLegalDocument
// ---------------------------------------------------------------------------

describe("acceptLegalDocument", () => {
  test("invalid document ID -> LegalDocumentNotFoundError", async () => {
    const { deps } = makeFakes([]);
    await assert.rejects(
      () =>
        acceptLegalDocument(
          { driverId: "drv_1", documentId: "does_not_exist", telegramUserId: "tg_1", userAgent: null, ipAddress: null },
          deps
        ),
      LegalDocumentNotFoundError
    );
  });

  test("inactive (superseded) document -> LegalDocumentInactiveError, no acceptance recorded", async () => {
    const staleTerms = doc({ id: "terms_v1", isActive: false });
    const { deps, acceptances } = makeFakes([staleTerms]);
    await assert.rejects(
      () =>
        acceptLegalDocument(
          { driverId: "drv_1", documentId: "terms_v1", telegramUserId: "tg_1", userAgent: null, ipAddress: null },
          deps
        ),
      LegalDocumentInactiveError
    );
    assert.equal(acceptances.length, 0);
  });

  test("first acceptance succeeds and is recorded", async () => {
    const terms = doc({ id: "terms_v1" });
    const { deps, acceptances } = makeFakes([terms]);
    const result = await acceptLegalDocument(
      { driverId: "drv_1", documentId: "terms_v1", telegramUserId: "tg_1", userAgent: "test-agent", ipAddress: "1.2.3.4" },
      deps
    );
    assert.deepEqual(result, { accepted: true, alreadyAccepted: false, documentId: "terms_v1" });
    assert.equal(acceptances.length, 1);
  });

  test("duplicate synchronization: accepting the same version twice is idempotent, not an error", async () => {
    const terms = doc({ id: "terms_v1" });
    const { deps, acceptances } = makeFakes([terms]);
    const params = { driverId: "drv_1", documentId: "terms_v1", telegramUserId: "tg_1", userAgent: null, ipAddress: null };

    const first = await acceptLegalDocument(params, deps);
    const second = await acceptLegalDocument(params, deps);

    assert.equal(first.alreadyAccepted, false);
    assert.equal(second.alreadyAccepted, true);
    assert.equal(acceptances.length, 1); // no duplicate row
  });

  test("two different drivers accepting the same document both succeed independently", async () => {
    const terms = doc({ id: "terms_v1" });
    const { deps, acceptances } = makeFakes([terms]);
    await acceptLegalDocument(
      { driverId: "drv_1", documentId: "terms_v1", telegramUserId: "tg_1", userAgent: null, ipAddress: null },
      deps
    );
    await acceptLegalDocument(
      { driverId: "drv_2", documentId: "terms_v1", telegramUserId: "tg_2", userAgent: null, ipAddress: null },
      deps
    );
    assert.equal(acceptances.length, 2);
  });
});

// ---------------------------------------------------------------------------
// activateLegalDocument
// ---------------------------------------------------------------------------

describe("activateLegalDocument", () => {
  test("activating a new version deactivates the previous version of the same type", async () => {
    const v1 = doc({ id: "terms_v1", version: 1, isActive: true });
    const v2 = doc({ id: "terms_v2", version: 2, isActive: false });
    const { deps, docs } = makeFakes([v1, v2]);

    await activateLegalDocument("terms_v2", deps);

    assert.equal(docs.get("terms_v1")!.isActive, false);
    assert.equal(docs.get("terms_v2")!.isActive, true);
  });

  test("activating one type's document never touches another type's active document", async () => {
    const termsV1 = doc({ id: "terms_v1", type: "terms_of_use", isActive: true });
    const termsV2 = doc({ id: "terms_v2", type: "terms_of_use", version: 2, isActive: false });
    const privacyV1 = doc({ id: "privacy_v1", type: "privacy_notice", isActive: true });
    const { deps, docs } = makeFakes([termsV1, termsV2, privacyV1]);

    await activateLegalDocument("terms_v2", deps);

    assert.equal(docs.get("privacy_v1")!.isActive, true);
  });

  test("invalid document ID -> LegalDocumentNotFoundError", async () => {
    const { deps } = makeFakes([]);
    await assert.rejects(() => activateLegalDocument("nope", deps), LegalDocumentNotFoundError);
  });
});

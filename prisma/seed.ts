/**
 * prisma/seed.ts
 *
 * Phase 4.6B — seeds the initial, placeholder legal documents so the
 * onboarding gate has something real to show. Content is NOT final legal
 * language (per scope) — swap it out later by publishing a new version via
 * this same script (bump `version`, keep `type`), never by editing an
 * existing row in place.
 *
 * Idempotent: re-running with unchanged version numbers is a no-op (the
 * (type, version) unique constraint is checked before inserting).
 *
 * Run with: npx prisma db seed
 */

import { createHash } from "crypto";
import { prisma } from "../lib/prisma";
import { activateLegalDocument } from "../lib/legal";

const PLACEHOLDER_TERMS = `SafeHaul Terms of Use (v1 — placeholder)

This is placeholder text for SafeHaul's Terms of Use. Final legal language
has not yet been written. This document exists to validate the versioning
and acceptance infrastructure only.`;

const PLACEHOLDER_PRIVACY = `SafeHaul Privacy Notice (v1 — placeholder)

This is placeholder text for SafeHaul's Privacy Notice. Final legal language
has not yet been written. This document exists to validate the versioning
and acceptance infrastructure only.`;

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function seedDocument(type: string, version: number, title: string, content: string) {
  const existing = await prisma.legalDocument.findUnique({
    where: { type_version: { type, version } },
  });

  const doc =
    existing ??
    (await prisma.legalDocument.create({
      data: {
        type,
        version,
        title,
        content,
        contentHash: hash(content),
        effectiveAt: new Date(),
        isActive: false, // activated explicitly below
      },
    }));

  await activateLegalDocument(doc.id);
  console.log(`[seed] ${type} v${version} active (id=${doc.id})`);
}

async function main() {
  await seedDocument("terms_of_use", 1, "SafeHaul Terms of Use", PLACEHOLDER_TERMS);
  await seedDocument("privacy_notice", 1, "SafeHaul Privacy Notice", PLACEHOLDER_PRIVACY);
}

main()
  .catch((err) => {
    console.error("[seed] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

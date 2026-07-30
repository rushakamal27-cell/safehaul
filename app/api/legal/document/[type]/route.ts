/**
 * GET /api/legal/document/[type]
 *
 * Returns the currently-active LegalDocument for the given type (e.g.
 * "terms_of_use", "privacy_notice"), including its full content.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  { params }: { params: { type: string } }
) {
  const { type } = params;

  const document = await prisma.legalDocument.findFirst({
    where: { type, isActive: true },
  });

  if (!document) {
    return NextResponse.json(
      { error: `No active legal document found for type "${type}"` },
      { status: 404 }
    );
  }

  return NextResponse.json({ document });
}

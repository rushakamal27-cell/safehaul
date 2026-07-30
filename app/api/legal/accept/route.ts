/**
 * POST /api/legal/accept
 *
 * Body: { driverId: string, documentId: string }
 *
 * Records a driver's acceptance of one specific (active) document version.
 * Idempotent — accepting the same version twice returns 200 both times (see
 * lib/legal.ts::acceptLegalDocument). userAgent/ipAddress are read from the
 * request itself, never trusted from the client body.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  acceptLegalDocument,
  LegalDocumentInactiveError,
  LegalDocumentNotFoundError,
} from "@/lib/legal";

function extractIpAddress(request: NextRequest): string | null {
  // Vercel (and most proxies) set X-Forwarded-For as a comma-separated list;
  // the first entry is the original client.
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return null;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const { driverId, documentId } = (body ?? {}) as { driverId?: unknown; documentId?: unknown };

  if (typeof driverId !== "string" || !driverId) {
    return NextResponse.json({ error: "driverId is required" }, { status: 400 });
  }
  if (typeof documentId !== "string" || !documentId) {
    return NextResponse.json({ error: "documentId is required" }, { status: 400 });
  }

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { telegramUserId: true },
  });
  if (!driver) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  try {
    const result = await acceptLegalDocument({
      driverId,
      documentId,
      telegramUserId: driver.telegramUserId,
      userAgent: request.headers.get("user-agent"),
      ipAddress: extractIpAddress(request),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof LegalDocumentNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof LegalDocumentInactiveError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[api/legal/accept] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

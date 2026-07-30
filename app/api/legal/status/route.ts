/**
 * GET /api/legal/status?driverId=...
 *
 * Returns the currently-active legal documents, which of them this driver
 * has already accepted, and whether onboarding is complete. See lib/legal.ts
 * for how "complete" is derived (never hardcodes a version number).
 */

import { NextRequest, NextResponse } from "next/server";
import { getLegalStatus } from "@/lib/legal";

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  const status = await getLegalStatus(driverId);
  return NextResponse.json(status);
}

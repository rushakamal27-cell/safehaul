import { NextRequest, NextResponse } from "next/server";
import { getMockAuditEvents } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  const events = getMockAuditEvents(driverId);

  return NextResponse.json({
    driverId,
    generatedAt: new Date().toISOString(),
    events,
  });
}

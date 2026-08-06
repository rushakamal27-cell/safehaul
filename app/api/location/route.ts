import { NextRequest, NextResponse } from "next/server";
import { getMockDriverLocation, getPilotDriverLocation } from "@/lib/location";
import { isPilotDriver } from "@/lib/driverEvents";
import type { ApiErrorResponse } from "@/lib/api/common";
import type { LocationApiResponse } from "@/lib/api/location";

// Return type is explicitly checked against the shared contract
// (lib/api/location.ts) both this route and client components import — see
// app/api/risk/route.ts for the same pattern (N4, Phase 5, 2026-08-05).
export async function GET(request: NextRequest): Promise<NextResponse<LocationApiResponse | ApiErrorResponse>> {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  try {
    const pilotDriver = await isPilotDriver(driverId);
    const location = pilotDriver
      ? await getPilotDriverLocation(driverId)
      : await getMockDriverLocation(driverId);

    return NextResponse.json(location);
  } catch (error) {
    // Server-side only: full error (including stack) for debugging, plus
    // the internal driverId for correlation — never sent to the client.
    // Matches the existing precedent in app/api/driver/route.ts and
    // app/api/incident/route.ts.
    console.error(`[api/location] Unhandled error for driverId=${driverId}:`, error);
    return NextResponse.json(
      { error: "Unable to load location data right now. Please try again." },
      { status: 500 }
    );
  }
}

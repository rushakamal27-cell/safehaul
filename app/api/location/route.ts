import { NextRequest, NextResponse } from "next/server";
import { getMockDriverLocation, getPilotDriverLocation } from "@/lib/location";
import { isPilotDriver } from "@/lib/driverEvents";

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  const pilotDriver = await isPilotDriver(driverId);
  const location = pilotDriver
    ? await getPilotDriverLocation(driverId)
    : await getMockDriverLocation(driverId);

  return NextResponse.json(location);
}

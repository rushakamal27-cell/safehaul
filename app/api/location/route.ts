import { NextRequest, NextResponse } from "next/server";
import { getMockDriverLocation } from "@/lib/location";

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  const location = await getMockDriverLocation(driverId);

  return NextResponse.json(location);
}

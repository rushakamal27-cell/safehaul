import { NextRequest, NextResponse } from "next/server";
import { calculateRisk } from "@/lib/riskEngine";
import { getRiskInputForDriver } from "@/lib/samsara";

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  const input  = await getRiskInputForDriver(driverId);
  const result = calculateRisk(input);

  return NextResponse.json({
    driverId,
    timestamp: new Date().toISOString(),
    input,
    result,
  });
}

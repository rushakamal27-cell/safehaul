import { NextRequest, NextResponse } from "next/server";
import { calculateRisk, RiskInput } from "@/lib/riskEngine";

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "Missing required query parameter: driverId" },
      { status: 400 }
    );
  }

  // TODO: Replace with live Samsara data once integration is built
  const mockInput: RiskInput = {
    safetyEvents: [
      { type: "speeding", severity: 3 },
      { type: "harsh_braking", severity: 2 },
    ],
    hosHours: 9.5,
    weatherRisk: 0.6,
    zoneRisk: 0.4,
    speed: 74,
  };

  const result = calculateRisk(mockInput);

  return NextResponse.json({
    driverId,
    timestamp: new Date().toISOString(),
    input: mockInput,
    result,
  });
}

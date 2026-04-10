import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateTodayTrip } from "@/lib/trip";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { driverId, description, location } = body;

    if (!driverId) {
      return NextResponse.json(
        { error: "driverId is required" },
        { status: 400 }
      );
    }

    const tripId = await getOrCreateTodayTrip(driverId);

    const incident = await prisma.incident.create({
      data: {
        driverId,
        tripId,
        description: description ?? null,
        location:    location ?? null,
      },
    });

    return NextResponse.json({ incident });
  } catch (error) {
    console.error("Incident API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

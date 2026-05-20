import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { getOrCreateTodayTrip } from "@/lib/trip";
import {
  uploadInspectionPhoto,
  signInspectionUrl,
} from "@/lib/supabaseStorage";
import {
  INSPECTION_SYSTEM_PROMPT,
  parseInspectionResponse,
} from "@/lib/inspection";
import { Prisma } from "@/lib/generated/prisma";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const driverId = formData.get("driverId") as string | null;
  const file     = formData.get("photo") as File | null;

  if (!driverId) {
    return NextResponse.json({ error: "Missing driverId" }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "Missing photo" }, { status: 400 });
  }

  // Convert File → Buffer for storage upload
  const arrayBuffer = await file.arrayBuffer();
  const buffer      = Buffer.from(arrayBuffer);
  const base64Image = buffer.toString("base64");

  // Upload compressed JPEG to Supabase Storage
  const inspectionId  = crypto.randomUUID();
  const storagePath   = `${driverId}/${inspectionId}.jpg`;
  await uploadInspectionPhoto(storagePath, buffer);

  // Call Claude Haiku with the image
  let analysisRaw: string;
  try {
    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system:     INSPECTION_SYSTEM_PROMPT,
      messages: [
        {
          role:    "user",
          content: [
            {
              type:   "image",
              source: { type: "base64", media_type: "image/jpeg", data: base64Image },
            },
            { type: "text", text: "Inspect this vehicle image." },
          ],
        },
      ],
    });
    analysisRaw = response.content[0].type === "text" ? response.content[0].text : "";
  } catch (err: any) {
    return NextResponse.json(
      { error: `AI analysis failed: ${err.message}` },
      { status: 502 }
    );
  }

  // Parse and validate the JSON response
  let result;
  try {
    result = parseInspectionResponse(analysisRaw);
  } catch (err: any) {
    return NextResponse.json(
      { error: `AI response invalid: ${err.message}` },
      { status: 502 }
    );
  }

  // Persist to DB
  const tripId      = await getOrCreateTodayTrip(driverId);
  const retainUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.inspection.create({
    data: {
      id:            inspectionId,
      driverId,
      tripId,
      photoUrl:      storagePath,
      overallResult: result.overallResult,
      summary:       result.summary,
      confidence:    result.confidence,
      checkItems:    result.checkItems as unknown as Prisma.InputJsonValue,
      analysisJson:  JSON.parse(analysisRaw) as unknown as Prisma.InputJsonValue,
      retainUntil,
    },
  });

  // Generate a 1-hour signed URL for immediate display
  const signedPhotoUrl = await signInspectionUrl(storagePath, 3600);

  return NextResponse.json({
    id:            inspectionId,
    overallResult: result.overallResult,
    summary:       result.summary,
    confidence:    result.confidence,
    checkItems:    result.checkItems,
    signedPhotoUrl,
  });
}

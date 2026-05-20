import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { removeInspectionPhotos } from "@/lib/supabaseStorage";

/**
 * GET /api/inspect/cleanup
 *
 * Finds inspection rows whose retainUntil date has passed and whose
 * photos haven't been expired yet, deletes the files from Supabase
 * Storage, then marks the DB rows (photoUrl = null, photosExpired = true).
 *
 * DB rows are KEPT permanently for audit history.
 * Called by Vercel cron at 3am UTC daily.
 */
export async function GET() {
  const expired = await prisma.inspection.findMany({
    where: {
      retainUntil:   { lte: new Date() },
      photosExpired: false,
      photoUrl:      { not: null },
    },
    select: { id: true, photoUrl: true },
  });

  if (expired.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  const paths = expired
    .map((r) => r.photoUrl)
    .filter((p): p is string => p !== null);

  await removeInspectionPhotos(paths);

  await prisma.inspection.updateMany({
    where: { id: { in: expired.map((r) => r.id) } },
    data:  { photoUrl: null, photosExpired: true },
  });

  return NextResponse.json({ deleted: paths.length });
}

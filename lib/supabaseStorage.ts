/**
 * lib/supabaseStorage.ts
 *
 * Supabase Storage client — server-side only.
 * Uses the service role key so it can write to private buckets.
 * Never import this in client components.
 */

import "server-only";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl         = process.env.SUPABASE_URL!;
const supabaseServiceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const INSPECTION_BUCKET = "inspections";

// Singleton — reused across requests in the same server process
let _client: ReturnType<typeof createClient> | null = null;

export function getStorageClient() {
  if (!_client) {
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }
    _client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

/** Upload a Buffer to the inspections bucket. Returns the storage path. */
export async function uploadInspectionPhoto(
  path: string,
  buffer: Buffer
): Promise<string> {
  const client = getStorageClient();
  const { error } = await client.storage
    .from(INSPECTION_BUCKET)
    .upload(path, buffer, { contentType: "image/jpeg", upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return path;
}

/** Generate a short-lived signed URL for a private inspection photo. */
export async function signInspectionUrl(
  path: string,
  expiresInSeconds = 3600
): Promise<string> {
  const client = getStorageClient();
  const { data, error } = await client.storage
    .from(INSPECTION_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to sign URL: ${error?.message}`);
  }
  return data.signedUrl;
}

/** Delete one or more inspection photos from storage. */
export async function removeInspectionPhotos(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const client = getStorageClient();
  const { error } = await client.storage
    .from(INSPECTION_BUCKET)
    .remove(paths);

  if (error) throw new Error(`Storage remove failed: ${error.message}`);
}

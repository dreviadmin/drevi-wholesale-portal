import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { PRESET_BUCKETS, sortBuckets, type StudioBucket } from "@/lib/studio/buckets";

/**
 * Every bucket, removed ones included (the board still needs their labels for
 * designs that sit in them). Falls back to the four presets if the table
 * cannot be read, so the Studio still renders.
 */
export async function loadStudioBuckets(): Promise<StudioBucket[]> {
  const { data, error } = await createAdminClient()
    .from("studio_buckets")
    .select("key, label, sort, preset, active")
    .order("sort")
    .order("created_at");
  if (error) {
    console.error("[studio] studio_buckets read failed:", error.message);
    return PRESET_BUCKETS;
  }
  return sortBuckets((data ?? []) as StudioBucket[]);
}

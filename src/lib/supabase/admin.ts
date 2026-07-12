import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

/**
 * Service-role client — BYPASSES RLS. Server-only (guarded by `server-only`).
 * Use exclusively in trusted server code (sync pipeline, server actions that
 * have already re-checked authorization). Never import into a client component.
 */
let cached: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(getEnv("NEXT_PUBLIC_SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      // Next.js 14 patches global fetch and caches GET requests by default, so
      // a Supabase read could serve stale rows (a backup once missed a
      // just-added staff member and would similarly miss fresh orders). Force
      // every admin-client request to hit the database directly.
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
  return cached;
}

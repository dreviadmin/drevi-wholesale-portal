"use client";

import { createBrowserClient } from "@supabase/ssr";

// Browser (anon) client for client components. RLS applies; never has elevated rights.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // A token refresh in the tab rewrites the same auth cookie, so it has to
      // carry the same Secure attribute the server sets or the browser write
      // silently drops it. Gated on the environment, not hardcoded, so
      // http://localhost still works in dev (see ./server.ts).
      cookieOptions: { secure: process.env.NODE_ENV === "production" },
    },
  );
}

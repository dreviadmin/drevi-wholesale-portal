"use client";

import { createBrowserClient } from "@supabase/ssr";

// Browser (anon) client for client components. RLS applies; never has elevated rights.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";

/**
 * Server-side (anon) client bound to the request cookies. Use in server
 * components, route handlers, and server actions for the *authenticated user's*
 * session. RLS applies — this client never bypasses row-level security.
 */
export function createServerSupabase() {
  const cookieStore = cookies();
  return createServerClient(getEnv("NEXT_PUBLIC_SUPABASE_URL"), getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component where cookies are read-only.
          // The session is refreshed in middleware instead — safe to ignore.
        }
      },
    },
  });
}

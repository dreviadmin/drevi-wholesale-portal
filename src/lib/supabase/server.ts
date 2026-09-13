import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";

// Secure is gated on the environment rather than hardcoded: a hardcoded true
// would make the auth cookie unsettable over http://localhost in dev, and every
// deployed environment (prod and the Vercel dev deploys) is https.
const SECURE_COOKIES = process.env.NODE_ENV === "production";

/**
 * Server-side (anon) client bound to the request cookies. Use in server
 * components, route handlers, and server actions for the *authenticated user's*
 * session. RLS applies — this client never bypasses row-level security.
 */
export function createServerSupabase() {
  const cookieStore = cookies();
  return createServerClient(getEnv("NEXT_PUBLIC_SUPABASE_URL"), getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    // Merged into DEFAULT_COOKIE_OPTIONS by @supabase/ssr, so the 400-day maxAge
    // that keeps the session alive across app restarts is untouched.
    cookieOptions: { secure: SECURE_COOKIES },
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

export type ActiveRole = "staff" | "buyer" | null;

/**
 * The signed-in user's active role, or null when there is no session, no active
 * row, or the lookup fails.
 *
 * This is the middleware rule (src/middleware.ts), reused by the landing routes
 * so "/" and /login can't disagree with the gate about where a user belongs —
 * keep the two in step. As there: plain selects (not maybeSingle(), which
 * errors on the duplicate buyer emails allowed since 0007) and duplicates
 * resolve to the MOST restrictive answer, every row must be active. Staff wins
 * a staff+buyer collision, matching what the login action does with one.
 *
 * A failed lookup returns null so the caller falls back to /login — unlike
 * middleware there is no page behind these routes to re-check authorization,
 * and /login renders the form only when the role is still unresolvable there.
 */
export async function resolveActiveRole(): Promise<ActiveRole> {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email;
  if (!email) return null;

  // RLS lets a user read only their own staff/buyer row (or staff read all).
  const [staffRes, buyerRes] = await Promise.all([
    supabase.from("staff_users").select("active").eq("email", email).limit(5),
    supabase.from("buyers").select("status").eq("email", email).limit(5),
  ]);
  if (staffRes.error || buyerRes.error) return null;

  if ((staffRes.data ?? []).some((r) => r.active === true)) return "staff";

  const buyerRows = buyerRes.data ?? [];
  return buyerRows.length > 0 && buyerRows.every((r) => r.status === "active") ? "buyer" : null;
}

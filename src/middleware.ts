import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Public paths — no auth required. Everything else is gated.
const PUBLIC_PATHS = ["/", "/login", "/forgot-password", "/wholesale"];
const PUBLIC_PREFIXES = ["/api/cron", "/api/dev", "/api/health"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Refreshes the session on every request. CRITICAL: any response we return —
  // including redirects — must carry the refreshed cookies, or the browser
  // keeps a rotated (revoked) token and the session dies at random.
  const redirectTo = (pathname: string) => {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    url.search = "";
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (isPublic(path)) return response;

  // Non-public API routes authenticate themselves (session + RLS) and are used
  // by every role (e.g. /api/orders/[id]/pdf from both buyer and staff UIs) —
  // don't page-redirect them here.
  if (path.startsWith("/api/")) return response;

  if (!user) return redirectTo("/login");

  const email = user.email ?? "";
  const isAdminRoute = path.startsWith("/admin");

  // RLS lets a user read only their own staff/buyer row (or staff read all).
  // NOT maybeSingle(): duplicate buyer emails made maybeSingle() error on
  // every request, which the transient-failure branch below turned into a
  // deterministic fail-open — a suspended buyer with a duplicate row kept
  // full access. Plain selects can't error on multiplicity.
  const [staffRes, buyerRes] = await Promise.all([
    supabase.from("staff_users").select("active").eq("email", email).limit(5),
    supabase.from("buyers").select("status").eq("email", email).limit(5),
  ]);

  // Transient DB failure (network blip, cold start) must NOT bounce a valid
  // session to /login. Fail open — every page re-checks authorization in its
  // own server code (requireStaff / requireAdminOrRedirect / RLS reads).
  if (staffRes.error || buyerRes.error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[middleware] role lookup failed — failing open:", staffRes.error?.message ?? buyerRes.error?.message);
    }
    return response;
  }

  const staffActive = (staffRes.data ?? []).some((r) => r.active === true);
  // Duplicates resolve to the MOST restrictive answer: every row must be
  // active for the buyer to pass.
  const buyerRows = buyerRes.data ?? [];
  const buyerActive = buyerRows.length > 0 && buyerRows.every((r) => r.status === "active");

  if (isAdminRoute) {
    if (staffActive) return response;
    return redirectTo(buyerActive ? "/catalog" : "/login");
  }

  // Buyer routes (/catalog, /cart, /account, /product, /order)
  if (buyerActive) return response;
  if (staffActive) return redirectTo("/admin");
  return redirectTo("/login");
}

export const config = {
  // Run on everything except Next internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};

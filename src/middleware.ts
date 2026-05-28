import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Public paths — no auth required. Everything else is gated.
const PUBLIC_PATHS = ["/", "/login", "/forgot-password"];
const PUBLIC_PREFIXES = ["/api/cron", "/api/dev"];

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

  // Refreshes the session cookie (and validates the JWT) on every request.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (isPublic(path)) return response;

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";

  if (!user) return NextResponse.redirect(loginUrl);

  const email = user.email ?? "";
  const isAdminRoute = path.startsWith("/admin");

  // RLS lets a user read only their own staff/buyer row (or staff read all).
  const [{ data: staff }, { data: buyer }] = await Promise.all([
    supabase.from("staff_users").select("active").eq("email", email).maybeSingle(),
    supabase.from("buyers").select("status").eq("email", email).maybeSingle(),
  ]);

  if (isAdminRoute) {
    if (staff?.active) return response;
    const url = request.nextUrl.clone();
    url.pathname = buyer?.status === "active" ? "/catalog" : "/login";
    return NextResponse.redirect(url);
  }

  // Buyer routes (/catalog, /cart, /account)
  if (buyer?.status === "active") return response;
  if (staff?.active) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin";
    return NextResponse.redirect(url);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on everything except Next internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};

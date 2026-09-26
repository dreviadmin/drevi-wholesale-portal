import { NextResponse } from "next/server";

// Request/response plumbing shared by every /api/wallet route. The routes are
// called cross-origin from drevifashion.com (the theme's JS), so each one
// answers a preflight and stamps CORS headers — but only for origins on the
// list. A browser on any other origin gets no header and the call is blocked
// by the browser itself; server-to-server callers (no Origin) are allowed
// through and rely on the session token or webhook HMAC instead.

const DEFAULT_ORIGINS = [
  "https://drevifashion.com",
  "https://www.drevifashion.com",
  "https://uqc34b-5y.myshopify.com",
];

function allowedOrigins(): string[] {
  const env = (process.env.WALLET_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = env.length ? env : DEFAULT_ORIGINS;
  // Theme previews and local dev never reach production, so the loosening is
  // confined to non-production builds by construction.
  if (process.env.NODE_ENV !== "production") list.push("http://localhost:9292", "http://127.0.0.1:9292", "http://localhost:8777");
  return list;
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  if (!allowedOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function preflight(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export function json(req: Request, body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { ...corsHeaders(req), "Cache-Control": "no-store" } });
}

export function fail(req: Request, error: string, status = 400, extra: Record<string, unknown> = {}): NextResponse {
  return json(req, { ok: false, error, ...extra }, status);
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Vercel sets x-forwarded-for; the first hop is the client. */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim().slice(0, 64);
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

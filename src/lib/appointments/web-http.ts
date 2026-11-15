import { NextResponse } from "next/server";

// CORS and JSON for the website booking routes (/api/appointments/*), kept
// apart from the wallet's so neither can loosen the other.
//
// Allowed origins: the wallet's list (WALLET_ALLOWED_ORIGINS, or drevifashion.com,
// www.drevifashion.com and the myshopify domain), plus Shopify "share preview"
// links (*.shopifypreview.com) so the booking box can be tried on a preview
// before it goes live. Theme previews opened as drevifashion.com/?preview_theme_id=…
// already count as drevifashion.com. Booking also REQUIRES an allowed Origin:
// the theme always sends one, scripts that leave it off are refused.

const DEFAULT_ORIGINS = ["https://drevifashion.com", "https://www.drevifashion.com", "https://uqc34b-5y.myshopify.com"];
const SHOPIFY_PREVIEW = /^https:\/\/[a-z0-9-]+\.shopifypreview\.com$/;

function listed(origin: string): boolean {
  const env = (process.env.WALLET_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = env.length ? env : DEFAULT_ORIGINS;
  if (process.env.NODE_ENV !== "production") list.push("http://localhost:9292", "http://127.0.0.1:9292");
  return list.includes(origin) || SHOPIFY_PREVIEW.test(origin);
}

/** An Origin header that is on the list (no Origin = not a browser on our site). */
export function originOk(req: Request): boolean {
  const o = req.headers.get("origin");
  return !!o && listed(o);
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !listed(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600", Vary: "Origin" };
}

export function preflight(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: cors(req) });
}
export function json(req: Request, body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { ...cors(req), "Cache-Control": "no-store" } });
}
export function fail(req: Request, error: string, status: number, code: string, extra: Record<string, unknown> = {}): NextResponse {
  return json(req, { ok: false, code, error, ...extra }, status);
}

/** Any unexpected error still answers with CORS headers and the contract's shape, so the page can show its WhatsApp fallback. */
export function guarded(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (e) {
      console.error(`[appointments-web] ${new URL(req.url).pathname} ${req.method}:`, (e as Error).message);
      return fail(req, "Something went wrong on our side. Please try again, or message us on WhatsApp.", 500, "server_error");
    }
  };
}

/** Vercel sets x-forwarded-for; the first hop is the visitor. */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim().slice(0, 64);
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

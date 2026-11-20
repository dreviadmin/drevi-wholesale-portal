import "server-only";

import { createHash } from "node:crypto";
import { orderTagBlocker } from "@/lib/wallet-core";

// Meta Conversions API: every new website booking is also reported from the
// server, as the same Schedule event the page's own Meta pixel fires, with the
// booking number as event_id on both. Meta then counts it once, and still sees
// the booking when the browser event is blocked (ad blockers, in-app browsers).
//
// Sent: the booking's WhatsApp number hashed (SHA-256 of the digits with the
// country code, as Meta asks), the _fbp and _fbc cookies the page passes (or an
// fbc made from the ad's fbclid), and the visitor's IP address and browser,
// which Meta needs for website events. Nothing else about the customer.
//
// Needs META_CAPI_TOKEN (Events Manager › the pixel › Settings › Conversions API
// › Generate access token), set in Vercel by the owner. Without it nothing is
// sent. META_PIXEL_ID overrides the shop's pixel. Off production nothing is sent
// unless META_CAPI_TEST_CODE is set, and then only as a test event (Events
// Manager › Test events).

const GRAPH = "https://graph.facebook.com/v23.0";
const SHOP_PIXEL = "1139607661846580";
const SITE = "https://drevifashion.com";
const PAGE: Record<string, string> = { store: "/pages/visit", video: "/pages/video-shopping", design: "/pages/custom-design" };

export interface MetaBooking {
  number: string; typeId: string; party: string; phoneE164: string; createdAt: string;
  fbp: string | null; fbc: string | null; fbclid: string | null; ip: string | null; userAgent: string | null;
}
export type MetaResult = { ok: true; note: string } | { ok: false; note: string };

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The event exactly as it goes to Meta (pure, for the tests). */
export function metaEvent(b: MetaBooking) {
  const at = Date.parse(b.createdAt);
  const fbc = b.fbc ?? (b.fbclid ? `fb.1.${at}.${b.fbclid}` : null);
  const user: Record<string, unknown> = { ph: [sha256(b.phoneE164.replace(/\D/g, ""))] };
  if (b.fbp) user.fbp = b.fbp;
  if (fbc) user.fbc = fbc;
  if (b.ip) user.client_ip_address = b.ip;
  if (b.userAgent) user.client_user_agent = b.userAgent.slice(0, 512);
  return {
    event_name: "Schedule",
    event_time: Math.floor(at / 1000),
    event_id: b.number,
    action_source: "website",
    event_source_url: SITE + (PAGE[b.typeId] ?? "/pages/visit"),
    user_data: user,
    custom_data: { content_name: b.typeId === "store" ? "Store visit" : b.typeId === "video" ? "Video call" : "Custom design consultation", visit_party: b.party },
  };
}

export async function sendMetaSchedule(b: MetaBooking): Promise<MetaResult> {
  const token = process.env.META_CAPI_TOKEN?.trim();
  if (!token) return { ok: false, note: "Not sent: META_CAPI_TOKEN is not set" };
  const test = process.env.META_CAPI_TEST_CODE?.trim() || null;
  const prod = orderTagBlocker({ VERCEL_ENV: process.env.VERCEL_ENV, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL }) === null;
  if (!prod && !test) return { ok: false, note: "Not sent: not production (set META_CAPI_TEST_CODE to send test events)" };
  if (!b.userAgent) return { ok: false, note: "Not sent: the request had no browser user agent" };
  const pixel = process.env.META_PIXEL_ID?.trim() || SHOP_PIXEL;
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${encodeURIComponent(pixel)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [metaEvent(b)], ...(test ? { test_event_code: test } : {}), access_token: token }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { ok: false, note: `No answer from Meta: ${(e as Error).message}` };
  }
  const text = await res.text().catch(() => "");
  if (res.ok && /"events_received"\s*:\s*1/.test(text)) return { ok: true, note: test ? "Sent to Meta as a test event" : "Sent to Meta" };
  let why = text.slice(0, 200);
  try { why = (JSON.parse(text) as { error?: { message?: string } }).error?.message?.slice(0, 200) ?? why; } catch { /* keep the raw text */ }
  return { ok: false, note: `Meta refused it (HTTP ${res.status}): ${why}` };
}

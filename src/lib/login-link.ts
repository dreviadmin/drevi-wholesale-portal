import "server-only";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { encryptPassword, decryptPassword } from "@/lib/crypto";
import { PORTAL_URL } from "@/lib/share";
import { hashToken, isTokenShaped, linkRefusal, loginLinkUrl, newToken, type LinkRefusal } from "@/lib/login-link-core";

// One-tap login links: https://<portal>/go/<token> signs one buyer in (0073).
// The WhatsApp launch templates carry the token as their URL-button value
// because Meta will not approve a template with a password in it.

type Admin = ReturnType<typeof createAdminClient>;

export type TokenResult = { ok: true; token: string; created: boolean } | { ok: false; error: string };

async function readLiveLink(admin: Admin, buyerId: string) {
  return admin
    .from("buyer_login_links")
    .select("id, token_encrypted")
    .eq("buyer_id", buyerId)
    .is("revoked_at", null)
    .maybeSingle();
}

/**
 * The buyer's live link token, minting one if there is none. The same token
 * comes back every time, so a link already sent keeps working when staff
 * copy or send it again.
 */
export async function getOrCreateLoginToken(buyerId: string, createdBy: string | null): Promise<TokenResult> {
  const admin = createAdminClient();
  const { data: buyer, error: buyerErr } = await admin
    .from("buyers")
    .select("id, encrypted_password")
    .eq("id", buyerId)
    .maybeSingle();
  if (buyerErr) return { ok: false, error: buyerErr.message };
  if (!buyer) return { ok: false, error: "Buyer not found." };
  // No auth user behind the buyer yet — a link would have nothing to sign into.
  if (!buyer.encrypted_password) return { ok: false, error: "Set credentials first." };

  const live = await readLiveLink(admin, buyerId);
  if (live.error) return { ok: false, error: live.error.message };
  if (live.data) {
    try {
      return { ok: true, token: decryptPassword(live.data.token_encrypted), created: false };
    } catch {
      return { ok: false, error: "The stored link could not be read — press New link." };
    }
  }

  const token = newToken();
  const { error } = await admin.from("buyer_login_links").insert({
    buyer_id: buyerId,
    token_hash: hashToken(token),
    token_encrypted: encryptPassword(token),
    created_by: createdBy,
  });
  if (error) {
    // 23505: another request minted this buyer's link first (the one-live-link
    // index). Hand back that one rather than failing.
    if (error.code === "23505") {
      const again = await readLiveLink(admin, buyerId);
      if (again.data) {
        try {
          return { ok: true, token: decryptPassword(again.data.token_encrypted), created: false };
        } catch {
          return { ok: false, error: "The stored link could not be read — press New link." };
        }
      }
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, token, created: true };
}

/** Kill the buyer's live link and mint a new one. Old messages stop working. */
export async function resetLoginToken(buyerId: string, createdBy: string | null): Promise<TokenResult> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("buyer_login_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("buyer_id", buyerId)
    .is("revoked_at", null);
  if (error) return { ok: false, error: error.message };
  return getOrCreateLoginToken(buyerId, createdBy);
}

/**
 * The origin this request arrived on, so a link copied on the dev site points
 * at dev (whose database holds the token) and one copied on prod at prod.
 * PORTAL_URL is the fallback outside a request.
 */
export function requestOrigin(): string {
  try {
    const h = headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
      return `${proto}://${host}`;
    }
  } catch {
    // Outside a request (scripts) — fall through.
  }
  return PORTAL_URL;
}

export function loginUrlFor(token: string, base: string = requestOrigin()): string {
  return loginLinkUrl(base, token);
}

export type ResolvedLink =
  | { ok: true; linkId: string; buyer: { id: string; email: string; business_name: string | null } }
  | { ok: false; reason: LinkRefusal | "error" };

/** What a tap on /go/<token> would open, or why it may not. Read-only. */
export async function resolveLoginToken(token: string): Promise<ResolvedLink> {
  if (!isTokenShaped(token)) return { ok: false, reason: "unknown" };
  const admin = createAdminClient();

  const { data: link, error: linkErr } = await admin
    .from("buyer_login_links")
    .select("id, buyer_id, revoked_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (linkErr) return { ok: false, reason: "error" };
  if (!link) return { ok: false, reason: "unknown" };

  const { data: buyer, error: buyerErr } = await admin
    .from("buyers")
    .select("id, status, email, encrypted_password, business_name")
    .eq("id", link.buyer_id)
    .maybeSingle();
  if (buyerErr) return { ok: false, reason: "error" };

  let sameEmailStatuses: string[] = [];
  let emailIsStaff = false;
  if (buyer?.email) {
    const [same, staff] = await Promise.all([
      admin.from("buyers").select("status").eq("email", buyer.email).limit(20),
      admin.from("staff_users").select("id").eq("email", buyer.email).limit(1),
    ]);
    if (same.error || staff.error) return { ok: false, reason: "error" };
    sameEmailStatuses = (same.data ?? []).map((r) => r.status as string);
    emailIsStaff = (staff.data ?? []).length > 0;
  }

  const refusal = linkRefusal({ link, buyer, sameEmailStatuses, emailIsStaff });
  if (refusal) return { ok: false, reason: refusal };
  return { ok: true, linkId: link.id, buyer: { id: buyer!.id, email: buyer!.email!, business_name: buyer!.business_name } };
}

export type SignInResult =
  | { ok: true; buyerId: string }
  | { ok: false; reason: LinkRefusal | "error" | "auth_failed"; detail?: string };

/**
 * Sign the current browser in as the link's buyer. Same two calls as
 * .local/mint-session.mjs: the admin API mints a magic-link token for the
 * buyer's existing auth user (nothing is emailed), and verifyOtp on the
 * cookie-bound client turns it into the session cookie the middleware reads —
 * the same session a password login produces.
 */
export async function signInWithLoginToken(token: string): Promise<SignInResult> {
  const resolved = await resolveLoginToken(token);
  if (!resolved.ok) return resolved;

  const admin = createAdminClient();
  const supabase = createServerSupabase();
  // GoTrue keeps one magic-link token per user, so two taps landing together
  // (a tap before hydration plus the auto-submit) can void each other's.
  // One fresh token and a second try absorbs that race.
  let detail = "";
  let signedIn = false;
  for (let attempt = 0; attempt < 2 && !signedIn; attempt++) {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: resolved.buyer.email });
    const hashed = data?.properties?.hashed_token;
    if (error || !hashed) return { ok: false, reason: "auth_failed", detail: error?.message ?? "no token" };
    const { error: verifyErr } = await supabase.auth.verifyOtp({ type: "email", token_hash: hashed });
    if (verifyErr) detail = verifyErr.message;
    else signedIn = true;
  }
  if (!signedIn) return { ok: false, reason: "auth_failed", detail };

  // Usage stats only — a failure here must not undo a good sign-in.
  const { data: row } = await admin.from("buyer_login_links").select("use_count").eq("id", resolved.linkId).maybeSingle();
  await admin
    .from("buyer_login_links")
    .update({ last_used_at: new Date().toISOString(), use_count: (row?.use_count ?? 0) + 1 })
    .eq("id", resolved.linkId);

  return { ok: true, buyerId: resolved.buyer.id };
}

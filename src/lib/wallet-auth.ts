import "server-only";

import { createHmac, createHash, randomInt, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { WALLET_DEFAULTS } from "@/lib/wallet-core";

// Who is this phone? Two halves. A one-time code over WhatsApp proves the
// person holds the number; a signed session token then stands in for that
// proof for 30 days so the wallet chip in the header doesn't cost an OTP on
// every visit. Neither touches Shopify accounts — those log in by email, and
// 217 of the 222 retail customers have none.

const OTP_WINDOW_MS = 10 * 60 * 1000;

function sessionSecret(): Buffer {
  const explicit = process.env.WALLET_SESSION_SECRET;
  if (explicit && explicit.length >= 32) return Buffer.from(explicit, "utf8");
  // Derived, not reused: the master key never signs anything directly.
  const master = process.env.PORTAL_PASSWORD_MASTER_KEY;
  if (!master) throw new Error("WALLET_SESSION_SECRET (or PORTAL_PASSWORD_MASTER_KEY) is required");
  return createHash("sha256").update("drevi-wallet-session:" + master).digest();
}

function otpHash(phone: string, code: string): string {
  return createHmac("sha256", sessionSecret()).update(`${phone}:${code}`).digest("hex");
}

export type OtpIssue =
  | { ok: true; code: string; id: string }
  | { ok: false; reason: "rate_limited_phone" | "rate_limited_ip" };

/**
 * Mint a 6-digit code for a phone. Rate-limited per phone and per IP by
 * counting recent rows; the code goes back to the caller ONLY so it can be
 * handed to the WhatsApp sender — it is never logged in production and never
 * stored, only its HMAC.
 */
export async function issueOtp(phone: string, ip: string | null): Promise<OtpIssue> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - OTP_WINDOW_MS).toISOString();

  const { count: byPhone } = await admin
    .from("wallet_otps").select("*", { count: "exact", head: true })
    .eq("phone", phone).gte("created_at", since);
  if ((byPhone ?? 0) >= WALLET_DEFAULTS.otpPerPhonePer10Min) return { ok: false, reason: "rate_limited_phone" };

  if (ip) {
    const { count: byIp } = await admin
      .from("wallet_otps").select("*", { count: "exact", head: true })
      .eq("ip", ip).gte("created_at", since);
    if ((byIp ?? 0) >= WALLET_DEFAULTS.otpPerIpPer10Min) return { ok: false, reason: "rate_limited_ip" };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const { data, error } = await admin
    .from("wallet_otps")
    .insert({
      phone,
      code_hash: otpHash(phone, code),
      expires_at: new Date(Date.now() + WALLET_DEFAULTS.otpTtlSeconds * 1000).toISOString(),
      ip,
    })
    .select("id")
    .single();
  if (error) throw new Error(`otp insert: ${error.message}`);
  return { ok: true, code, id: data.id as string };
}

export type OtpVerify = { ok: true } | { ok: false; reason: "no_code" | "expired" | "too_many_attempts" | "wrong" };

/** Check a code against the newest unconsumed one for the phone. */
export async function verifyOtp(phone: string, code: string): Promise<OtpVerify> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("wallet_otps")
    .select("id, code_hash, attempts, expires_at")
    .eq("phone", phone)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; code_hash: string; attempts: number; expires_at: string }>();
  if (!row) return { ok: false, reason: "no_code" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (row.attempts >= WALLET_DEFAULTS.otpMaxAttempts) return { ok: false, reason: "too_many_attempts" };

  const given = Buffer.from(otpHash(phone, code.replace(/\D/g, "")), "hex");
  const want = Buffer.from(row.code_hash, "hex");
  const match = given.length === want.length && timingSafeEqual(given, want);

  if (!match) {
    await admin.from("wallet_otps").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return { ok: false, reason: "wrong" };
  }
  await admin.from("wallet_otps").update({ consumed_at: new Date().toISOString() }).eq("id", row.id);
  return { ok: true };
}

// ---- Session tokens -------------------------------------------------------

const b64u = (b: Buffer) => b.toString("base64url");

export function signSession(phone: string, now: Date = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + WALLET_DEFAULTS.sessionDays * 86400;
  const payload = b64u(Buffer.from(JSON.stringify({ p: phone, exp }), "utf8"));
  const sig = b64u(createHmac("sha256", sessionSecret()).update("v1." + payload).digest());
  return `v1.${payload}.${sig}`;
}

/** The phone the token vouches for, or null. */
export function verifySession(token: string | null | undefined, now: Date = new Date()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload, sig] = parts;
  const want = createHmac("sha256", sessionSecret()).update("v1." + payload).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, "base64url"); } catch { return null; }
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { p?: string; exp?: number };
    if (!obj.p || !obj.exp) return null;
    if (obj.exp * 1000 < now.getTime()) return null;
    return obj.p;
  } catch {
    return null;
  }
}

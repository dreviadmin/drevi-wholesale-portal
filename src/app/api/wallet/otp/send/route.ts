import { normalizePhone } from "@/lib/wallet-core";
import { issueOtp } from "@/lib/wallet-auth";
import { sendWalletOtp } from "@/lib/wallet-whatsapp";
import { clientIp, fail, json, preflight, readJson } from "@/lib/wallet-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step one of logging in: a six-digit code to the phone, over WhatsApp.
// Public and unauthenticated by nature, so it is the most rate-limited route
// here (3 per phone, 12 per IP, per ten minutes) and it never says whether a
// wallet exists for the number — that would let anyone probe the list.

export function OPTIONS(req: Request) {
  return preflight(req);
}

export async function POST(req: Request) {
  const body = await readJson<{ phone?: string }>(req);
  const phone = normalizePhone(body?.phone);
  if (!phone) return fail(req, "Enter a valid mobile number.");

  const issued = await issueOtp(phone, clientIp(req));
  if (!issued.ok) {
    return fail(req, issued.reason === "rate_limited_phone"
      ? "Too many codes sent to this number. Try again in a few minutes."
      : "Too many requests. Try again in a few minutes.", 429);
  }

  const wa = await sendWalletOtp(phone, issued.code);
  // Local testing only: hand the code back so a dev can log in without a
  // WhatsApp round-trip. Both guards must hold; production never returns it.
  const reveal = process.env.NODE_ENV !== "production" && (process.env.WALLET_DEV_RETURN_OTP ?? "").toLowerCase() === "true";
  return json(req, {
    ok: true,
    sent: wa.sent,
    dry_run: wa.dryRun ?? false,
    expires_in: 600,
    ...(reveal ? { dev_code: issued.code } : {}),
  });
}

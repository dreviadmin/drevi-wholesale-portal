import { formatPhone, normalizePhone } from "@/lib/wallet-core";
import { signSession, verifyOtp } from "@/lib/wallet-auth";
import { ensureAccount, sweepExpiry } from "@/lib/wallet";
import { fail, json, preflight, readJson } from "@/lib/wallet-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step two: the code comes back, and if it matches the phone gets a 30-day
// session token. A phone that has never had a wallet gets one here — with the
// welcome credit — because logging in IS joining. That is deliberate: it is
// the only path that both proves the number and creates the wallet in one go.

export function OPTIONS(req: Request) {
  return preflight(req);
}

export async function POST(req: Request) {
  const body = await readJson<{ phone?: string; code?: string; name?: string }>(req);
  const phone = normalizePhone(body?.phone);
  const code = (body?.code ?? "").replace(/\D/g, "");
  if (!phone || code.length !== 6) return fail(req, "Enter the 6-digit code from WhatsApp.");

  const v = await verifyOtp(phone, code);
  if (!v.ok) {
    const msg = v.reason === "expired" ? "That code has expired. Send a new one."
      : v.reason === "too_many_attempts" ? "Too many tries. Send a new code."
      : v.reason === "no_code" ? "Send a code first."
      : "That code isn't right.";
    return fail(req, msg, 401, { reason: v.reason });
  }

  const name = (body?.name ?? "").trim().slice(0, 80) || null;
  // Proving the number is not consenting to marketing; only the popup's
  // ticked box sets wa_opt_in_at. A wallet created here is a login, no more.
  const { account: raw, created } = await ensureAccount({ phone, name, source: "popup", waOptIn: false });
  const account = await sweepExpiry(raw);
  return json(req, {
    ok: true,
    token: signSession(phone),
    created,
    wallet: {
      phone: formatPhone(account.phone),
      name: account.name,
      balance_paise: account.balance_paise,
      expires_at: account.expires_at,
    },
  });
}

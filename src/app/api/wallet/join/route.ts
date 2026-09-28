import { formatPhone } from "@/lib/wallet-core";
import { openWalletForCustomer, sweepExpiry } from "@/lib/wallet";
import { customerFromRequest } from "@/lib/wallet-identity";
import { fail, json, preflight, readJson } from "@/lib/wallet-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A SIGNED-IN shopper adds their mobile number and the wallet opens with its
// welcome credit. Identity comes from the theme's signed customer token.

export function OPTIONS(req: Request) {
  return preflight(req);
}

export async function POST(req: Request) {
  const customerGid = customerFromRequest(req);
  if (!customerGid) return fail(req, "Please sign in again.", 401);
  const body = await readJson<{ name?: string; phone?: string; consent?: boolean }>(req);

  const r = await openWalletForCustomer({ customerGid, phone: body?.phone ?? "", name: body?.name ?? null, consent: body?.consent === true, source: "popup" });
  if (!r.ok) {
    const msg = r.reason === "invalid_phone" ? "Enter your 10-digit mobile number."
      : r.reason === "phone_in_use" ? "This number is already linked to another Drevi account. Message us on WhatsApp at +91 88280 43555 and we will sort it out."
      : "Please sign in again.";
    return fail(req, msg, r.reason === "phone_in_use" ? 409 : 400, { reason: r.reason });
  }
  const account = await sweepExpiry(r.account);
  return json(req, {
    ok: true,
    created: r.created,
    wallet: { phone: formatPhone(account.phone), name: account.name, balance_paise: account.balance_paise, expires_at: account.expires_at },
  });
}

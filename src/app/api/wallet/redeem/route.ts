import { verifySession } from "@/lib/wallet-auth";
import { createRedemption, getAccountByPhone, sweepExpiry, voidOpenRedemptions } from "@/lib/wallet";
import { bearer, fail, json, preflight, readJson } from "@/lib/wallet-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Use ₹X from your wallet", from the cart. Mints a single-use discount code
// for this cart and hands it back; the theme applies it. Nothing is debited
// here — the debit happens on orders/create for what Shopify actually
// allocated, and a code that is never used lapses in 30 minutes.
//
// DELETE releases the reservation (the customer unticked the box).

export function OPTIONS(req: Request) {
  return preflight(req);
}

export async function POST(req: Request) {
  const phone = verifySession(bearer(req));
  if (!phone) return fail(req, "Not signed in.", 401);

  const body = await readJson<{ subtotal_paise?: number; amount_paise?: number | null; cart_token?: string | null }>(req);
  const subtotal = Number(body?.subtotal_paise);
  if (!Number.isFinite(subtotal) || subtotal <= 0) return fail(req, "Cart subtotal missing.");

  const found = await getAccountByPhone(phone);
  if (!found) return fail(req, "No wallet for this number.", 404);
  const account = await sweepExpiry(found);

  const r = await createRedemption({
    account,
    subtotalPaise: Math.floor(subtotal),
    requestedPaise: body?.amount_paise ?? null,
    cartToken: body?.cart_token ?? null,
  });
  if (!r.ok) {
    const msg = r.reason === "below_minimum" ? `Wallet can be used on orders of ₹${Math.floor(r.minOrderPaise / 100).toLocaleString("en-IN")} and above.`
      : r.reason === "no_balance" ? "Nothing in the wallet to use."
      : "Couldn't work out an amount for this cart.";
    return json(req, { ok: false, error: msg, reason: r.reason, min_order_paise: r.minOrderPaise }, 422);
  }
  return json(req, { ok: true, code: r.code, amount_paise: r.amountPaise, expires_at: r.expiresAt });
}

export async function DELETE(req: Request) {
  const phone = verifySession(bearer(req));
  if (!phone) return fail(req, "Not signed in.", 401);
  const account = await getAccountByPhone(phone);
  if (account) await voidOpenRedemptions(account.id);
  return json(req, { ok: true });
}

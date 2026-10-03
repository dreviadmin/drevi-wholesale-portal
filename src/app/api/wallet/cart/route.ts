import { guarded } from "@/lib/wallet-http";
import { getAccountByCustomer, identifyCartForAccount, liveOpenRedemptions } from "@/lib/wallet";
import { customerFromRequest } from "@/lib/wallet-identity";
import { fail, json, preflight, readJson } from "@/lib/wallet-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The bag calls this when the wallet holds an open reservation that this
// cart doesn't show — another device, or an identification that didn't take
// the first time. It gives the cart the customer's identity so Shopify
// applies the customer-limited discount to it. Nothing is reserved or
// released here; with no open reservation it simply says so.

export function OPTIONS(req: Request) {
  return preflight(req);
}

async function postHandler(req: Request) {
  const customerGid = customerFromRequest(req);
  if (!customerGid) return fail(req, "Please sign in again.", 401);
  const body = await readJson<{ cart_token?: string | null }>(req);
  const account = await getAccountByCustomer(customerGid);
  const open = account ? (await liveOpenRedemptions(account.id))[0] ?? null : null;
  if (!account || !open) return json(req, { ok: true, identified: false, redemption: null });
  const identified = await identifyCartForAccount(account, body?.cart_token);
  return json(req, { ok: true, identified, redemption: open });
}
export const POST = guarded(postHandler);

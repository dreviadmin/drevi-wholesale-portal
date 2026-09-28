import { createHmac, timingSafeEqual } from "node:crypto";

// Storefront identity for the wallet.
//
// Shopify's own sign-in (email + one-time code, new customer accounts) is the
// authentication. The theme then renders, for a signed-in customer only,
//
//   "<customerId>.<unixSeconds>.<hex HMAC-SHA256 of "<customerId>.<unixSeconds>">"
//
// with Liquid's hmac_sha256 filter and a key kept in a shop metafield
// (drevi.wallet_key) that Liquid can read and nothing public can. The portal
// holds the same key (WALLET_STOREFRONT_SECRET). The token only carries "who
// is signed in" across to us; it is short-lived and never stored.

export const TOKEN_MAX_AGE_S = 24 * 3600;
const FUTURE_SKEW_S = 300;

export function signCustomerToken(customerId: string | number, ts: number, secret: string): string {
  const msg = `${customerId}.${ts}`;
  return `${msg}.${createHmac("sha256", secret).update(msg).digest("hex")}`;
}

/** The customer's GID if the token is genuine and fresh, else null. */
export function checkCustomerToken(token: string | null | undefined, secret: string, nowS: number = Math.floor(Date.now() / 1000)): string | null {
  if (!token || !secret) return null;
  const m = /^(\d{1,20})\.(\d{9,11})\.([0-9a-f]{64})$/.exec(token.trim());
  if (!m) return null;
  const [, id, tsRaw, sig] = m;
  const ts = Number(tsRaw);
  if (ts > nowS + FUTURE_SKEW_S || nowS - ts > TOKEN_MAX_AGE_S) return null;
  const want = createHmac("sha256", secret).update(`${id}.${tsRaw}`).digest();
  const given = Buffer.from(sig, "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return `gid://shopify/Customer/${id}`;
}

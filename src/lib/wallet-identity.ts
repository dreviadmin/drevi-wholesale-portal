import "server-only";

import { checkCustomerToken } from "@/lib/wallet-token";
import { bearer } from "@/lib/wallet-http";

/** The signed-in Shopify customer behind a storefront request, or null. */
export function customerFromRequest(req: Request): string | null {
  const secret = process.env.WALLET_STOREFRONT_SECRET ?? "";
  if (secret.length < 32) {
    console.error("[wallet] WALLET_STOREFRONT_SECRET is missing or shorter than 32 characters");
    return null;
  }
  return checkCustomerToken(bearer(req), secret);
}

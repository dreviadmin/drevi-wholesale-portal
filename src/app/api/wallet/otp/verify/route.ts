import { formatPhone, normalizePhone } from "@/lib/wallet-core";
import { signSession, verifyOtp } from "@/lib/wallet-auth";
import { ensureAccount, linkShopifyCustomer, sweepExpiry } from "@/lib/wallet";
import { sendWalletWelcome } from "@/lib/wallet-whatsapp";
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
  const body = await readJson<{ phone?: string; code?: string; name?: string; consent?: boolean }>(req);
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
  // Proving the number is not consenting to marketing: wa-opt-in is set only
  // when the WhatsApp box was ticked. Either way the phone becomes (or is
  // matched to) a Shopify customer, so the wallet page can list their orders
  // and the seed/order webhooks find them. Shopify being briefly unhappy
  // must not block a login; the link is repaired on the next order.
  const consent = body?.consent === true;
  let customerId: string | null = null;
  try {
    customerId = await linkShopifyCustomer({ phone, name, tags: consent ? ["enquiry", "wa-opt-in", "source:wallet"] : ["enquiry", "source:wallet"] });
  } catch (e) {
    console.warn("[wallet-verify] shopify link failed:", (e as Error).message);
  }
  const { account: raw, created } = await ensureAccount({ phone, name, shopifyCustomerId: customerId, source: "popup", waOptIn: consent });
  const account = await sweepExpiry(raw);
  // The welcome is a marketing message: only with consent, only for a new
  // wallet, and never in the way of the login (the send may fail while the
  // template is still under review — the balance is on screen regardless).
  if (created && consent) void sendWalletWelcome(phone, name, account.balance_paise);
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

import { normalizePhone } from "@/lib/wallet-core";
import { issueOtp } from "@/lib/wallet-auth";
import { ensureAccount, linkShopifyCustomer } from "@/lib/wallet";
import { sendWalletWelcome } from "@/lib/wallet-whatsapp";
import { clientIp, fail, json, preflight, readJson } from "@/lib/wallet-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The popup. Name + phone + a ticked WhatsApp box. Creates the Shopify
// customer (tagged so the WhatsApp list and the enquiry reports pick them up),
// opens the wallet with its welcome credit, and sends the welcome — which is
// the only place the ₹1,000 is ever announced, so a made-up number gets
// nothing it can use. No OTP here on purpose: the send IS the check.
//
// Abuse surface is kept small three ways: the honeypot field, the same
// per-IP budget the OTP route uses, and one wallet per phone regardless of
// how many times the form is submitted.

const TAGS = ["enquiry", "wa-opt-in", "source:popup"];

export function OPTIONS(req: Request) {
  return preflight(req);
}

export async function POST(req: Request) {
  const body = await readJson<{ name?: string; phone?: string; consent?: boolean; website?: string }>(req);
  // Honeypot: a real form never fills "website".
  if (body?.website) return json(req, { ok: true, joined: true });

  const phone = normalizePhone(body?.phone);
  if (!phone) return fail(req, "Enter a valid mobile number.");
  if (body?.consent !== true) return fail(req, "Tick the box so we can message you on WhatsApp.");
  const name = (body?.name ?? "").trim().slice(0, 80) || null;

  // Borrow the OTP table's per-IP budget without sending a code: it is the
  // cheapest rate limit we have and it already exists.
  const budget = await issueOtp(phone, clientIp(req));
  if (!budget.ok) return fail(req, "Too many sign-ups from here. Try again in a few minutes.", 429);

  let customerId: string | null = null;
  try {
    customerId = await linkShopifyCustomer({ phone, name, tags: TAGS });
  } catch (e) {
    // The wallet should still open if Shopify is briefly unhappy; the link is
    // repaired on the first order (accountForOrder) or by the seed's re-run.
    console.warn("[wallet-join] shopify link failed:", (e as Error).message);
  }

  const { account, created } = await ensureAccount({ phone, name, shopifyCustomerId: customerId, source: "popup", waOptIn: true });
  if (created) await sendWalletWelcome(phone, name, account.balance_paise);

  return json(req, { ok: true, joined: true, created });
}

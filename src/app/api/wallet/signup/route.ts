import { normalizeEmail, normalizePhone } from "@/lib/wallet-core";
import { recordSignup, signupBudgetOk, WALLET_TAGS } from "@/lib/wallet";
import { createCustomerWithEmail, customerWithPhone, findCustomerByEmail } from "@/lib/wallet-shopify";
import { clientIp, fail, json, preflight, readJson } from "@/lib/wallet-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The wallet sign-up form, for a shopper who is NOT signed in: name, email,
// mobile number (all required) and the WhatsApp box. It keeps the lead and
// creates their Shopify customer when the email is new, then the theme sends
// them to Shopify's own sign-in (an emailed code). Their wallet opens the
// moment they come back signed in (/api/wallet/me claims this row).
//
// Unauthenticated, so it never changes an EXISTING Shopify customer — that
// waits until the shopper has proved the email by signing in. It also answers
// the same way whether or not an email or phone is already known, so it can't
// be used to look people up.

export function OPTIONS(req: Request) {
  return preflight(req);
}

export async function POST(req: Request) {
  const body = await readJson<{ name?: string; email?: string; phone?: string; consent?: boolean; website?: string }>(req);
  if (body?.website) return json(req, { ok: true }); // honeypot

  const name = (body?.name ?? "").trim().slice(0, 80);
  const email = normalizeEmail(body?.email);
  const phone = normalizePhone(body?.phone);
  if (name.length < 2) return fail(req, "Enter your name.");
  if (!email) return fail(req, "Enter a valid email address.");
  if (!phone) return fail(req, "Enter your 10-digit mobile number.");
  const consent = body?.consent === true;
  const ip = clientIp(req);

  if (!(await signupBudgetOk(ip, email))) return fail(req, "Too many sign-ups from here. Try again in a few minutes.", 429);

  let customerId: string | null = null;
  try {
    const existing = await findCustomerByEmail(email);
    if (existing) {
      customerId = existing.id; // left untouched until they sign in
    } else {
      const phoneOwner = await customerWithPhone(phone);
      const [first, ...rest] = name.split(/\s+/);
      const c = await createCustomerWithEmail({
        email,
        e164: phoneOwner ? null : phone,
        firstName: first,
        lastName: rest.join(" ") || null,
        tags: [WALLET_TAGS[1], "wallet-signup", ...(consent ? ["wa-opt-in"] : []), ...(phoneOwner ? ["phone-review"] : [])],
        note: phoneOwner ? `Wallet sign-up gave +${phone}, which is on another customer record.` : undefined,
      });
      customerId = c.id;
    }
  } catch (e) {
    // The lead is still kept below, and the wallet still opens at sign-in.
    console.warn("[wallet-signup] shopify:", (e as Error).message);
  }

  await recordSignup({ email, name, phone, consent, ip, shopifyCustomerId: customerId });
  return json(req, { ok: true });
}

import { formatPhone } from "@/lib/wallet-core";
import { reservedPaise, statement, sweepExpiry, walletConfig, walletForSignedIn } from "@/lib/wallet";
import { customerFromRequest } from "@/lib/wallet-identity";
import { fetchCustomerOrders } from "@/lib/wallet-shopify";
import { fail, json, preflight } from "@/lib/wallet-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The wallet page and the header chip both read this. Balance, the rolling
// expiry, the statement in plain words, and the customer's recent orders
// pulled from Shopify by the customer id the wallet is linked to — so a
// phone-first shopper gets an account page without a Shopify account.

export function OPTIONS(req: Request) {
  return preflight(req);
}

export async function GET(req: Request) {
  const customerGid = customerFromRequest(req);
  if (!customerGid) return fail(req, "Please sign in again.", 401);

  // Opens the wallet on the way if the shopper filled the sign-up form before
  // signing in, or already has a phone on their Shopify record.
  const w = await walletForSignedIn(customerGid);
  if (!w.account) {
    const c = w.customer;
    return json(req, {
      ok: true,
      joined: false,
      reason: w.reason ?? null,
      name: c ? [c.firstName, c.lastName].filter(Boolean).join(" ") || null : null,
      phone: w.suggestedPhone ?? null,
    });
  }
  const account = await sweepExpiry(w.account);

  const url = new URL(req.url);
  const wantOrders = url.searchParams.get("orders") !== "0";
  const [rows, reserved, orders] = await Promise.all([
    statement(account.id, 50),
    reservedPaise(account.id),
    wantOrders && account.shopify_customer_id ? fetchCustomerOrders(account.shopify_customer_id, 10).catch(() => []) : Promise.resolve([]),
  ]);
  const cfg = walletConfig();
  return json(req, {
    ok: true,
    joined: true,
    wallet: {
      phone: formatPhone(account.phone),
      name: account.name,
      balance_paise: account.balance_paise,
      available_paise: Math.max(0, account.balance_paise - reserved),
      expires_at: account.expires_at,
      min_order_paise: cfg.minOrderPaise,
      earn_percent: cfg.earnPercent,
    },
    statement: rows.map((r) => ({
      id: r.id, kind: r.kind, label: r.label, amount_paise: r.amount_paise, balance_after_paise: r.balance_after_paise, at: r.created_at,
    })),
    orders,
  });
}

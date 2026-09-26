import { formatPhone } from "@/lib/wallet-core";
import { verifySession } from "@/lib/wallet-auth";
import { getAccountByPhone, reservedPaise, statement, sweepExpiry, walletConfig } from "@/lib/wallet";
import { fetchCustomerOrders } from "@/lib/wallet-shopify";
import { bearer, fail, json, preflight } from "@/lib/wallet-http";

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
  const phone = verifySession(bearer(req));
  if (!phone) return fail(req, "Not signed in.", 401);

  const found = await getAccountByPhone(phone);
  if (!found) return fail(req, "No wallet for this number.", 404);
  const account = await sweepExpiry(found);

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

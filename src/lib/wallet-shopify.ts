import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";
import { paiseToDecimal, toPaise, WALLET_DEFAULTS } from "@/lib/wallet-core";

// The wallet's Shopify client. It does NOT share the portal's app: "Drevi
// Pipeline" holds product/inventory scopes only, and the wallet needs
// customers, discounts and orders. Those live on "Drevi Admin Automation",
// so this module authenticates as that app (WALLET_SHOPIFY_CLIENT_ID/SECRET)
// with the same client-credentials grant lib/shopify-auth.ts uses, cached
// under its own row so the two tokens never overwrite each other.

export const WALLET_API_VERSION = "2026-01";
const TOKEN_ROW_ID = "wallet";
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

function creds() {
  return {
    domain: getEnv("SHOPIFY_STORE_DOMAIN"),
    clientId: process.env.WALLET_SHOPIFY_CLIENT_ID || getEnv("SHOPIFY_CLIENT_ID"),
    clientSecret: process.env.WALLET_SHOPIFY_CLIENT_SECRET || getEnv("SHOPIFY_CLIENT_SECRET"),
  };
}

async function fetchToken(): Promise<{ access_token: string; expires_in: number }> {
  const { domain, clientId, clientSecret } = creds();
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`wallet Shopify token (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("wallet Shopify token response had no access_token");
  return { access_token: j.access_token, expires_in: j.expires_in ?? 86399 };
}

async function token(force = false): Promise<string> {
  const admin = createAdminClient();
  if (!force) {
    const { data } = await admin.from("shopify_tokens").select("access_token, expires_at").eq("id", TOKEN_ROW_ID)
      .maybeSingle<{ access_token: string; expires_at: string }>();
    if (data?.access_token && new Date(data.expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) return data.access_token;
  }
  const t = await fetchToken();
  await admin.from("shopify_tokens").upsert({
    id: TOKEN_ROW_ID, access_token: t.access_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), updated_at: new Date().toISOString(),
  });
  return t.access_token;
}

export async function walletGql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const url = `https://${creds().domain}/admin/api/${WALLET_API_VERSION}/graphql.json`;
  const call = (tok: string) => fetch(url, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": tok, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  let res = await call(await token());
  if (res.status === 401) res = await call(await token(true));
  if (!res.ok) throw new Error(`wallet Shopify GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Shopify: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data as T;
}

interface UserError { field?: string[] | null; message: string }
function throwUserErrors(what: string, errors: UserError[] | null | undefined): void {
  if (!errors?.length) return;
  throw new Error(`${what}: ${errors.map((e) => [e.field?.join("."), e.message].filter(Boolean).join(" — ")).join("; ")}`);
}

// ---- Customers -------------------------------------------------------------

export interface ShopifyCustomerLite { id: string; phone: string | null; firstName: string | null; lastName: string | null; tags: string[] }

/** Find by phone. Shopify stores E.164 with the plus; search both spellings. */
export async function findCustomerByPhone(e164: string): Promise<ShopifyCustomerLite | null> {
  const q = `phone:+${e164} OR phone:${e164}`;
  const d = await walletGql<{ customers: { nodes: ShopifyCustomerLite[] } }>(
    `query($q:String!){ customers(first:5, query:$q){ nodes{ id phone firstName lastName tags } } }`, { q });
  const want = "+" + e164;
  return d.customers.nodes.find((c) => (c.phone ?? "").replace(/\s/g, "") === want) ?? d.customers.nodes[0] ?? null;
}

export async function createCustomer(input: { e164: string; firstName?: string | null; lastName?: string | null; tags: string[]; note?: string }): Promise<ShopifyCustomerLite> {
  const d = await walletGql<{ customerCreate: { customer: ShopifyCustomerLite | null; userErrors: UserError[] } }>(
    `mutation($input: CustomerInput!){ customerCreate(input:$input){ customer{ id phone firstName lastName tags } userErrors{ field message } } }`,
    { input: { phone: "+" + input.e164, firstName: input.firstName ?? undefined, lastName: input.lastName ?? undefined, tags: input.tags, note: input.note } },
  );
  throwUserErrors("customerCreate", d.customerCreate.userErrors);
  if (!d.customerCreate.customer) throw new Error("customerCreate returned no customer");
  return d.customerCreate.customer;
}

export async function addCustomerTags(customerId: string, tags: string[]): Promise<void> {
  const d = await walletGql<{ tagsAdd: { userErrors: UserError[] } }>(
    `mutation($id:ID!, $tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ field message } } }`, { id: customerId, tags });
  throwUserErrors("tagsAdd", d.tagsAdd.userErrors);
}

// ---- Discount codes (the settlement instrument) ---------------------------

/**
 * A single-use, fixed-amount code for exactly this cart's redemption. Expires
 * in 30 minutes; whichever comes first — the order, or the clock — ends it.
 * The ₹5,000 minimum is repeated here as belt-and-braces: the route already
 * enforced it, but a code that reaches checkout should carry its own rule.
 */
export async function mintRedemptionCode(input: { code: string; amountPaise: number; minOrderPaise: number; ttlSeconds?: number }): Promise<string> {
  const now = new Date();
  const ends = new Date(now.getTime() + (input.ttlSeconds ?? WALLET_DEFAULTS.redemptionTtlSeconds) * 1000);
  const d = await walletGql<{ discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: UserError[] } }>(
    `mutation($d: DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$d){ codeDiscountNode{ id } userErrors{ field message } } }`,
    {
      d: {
        title: "Drevi Wallet",
        code: input.code,
        startsAt: now.toISOString(),
        endsAt: ends.toISOString(),
        usageLimit: 1,
        appliesOncePerCustomer: false,
        // Required from 2026-01: who the code is for. Everyone — the code
        // itself is the secret, and it dies after one use anyway.
        context: { all: "ALL" },
        combinesWith: { productDiscounts: true, orderDiscounts: false, shippingDiscounts: true },
        minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: paiseToDecimal(input.minOrderPaise) } },
        customerGets: {
          value: { discountAmount: { amount: paiseToDecimal(input.amountPaise), appliesOnEachItem: false } },
          items: { all: true },
        },
      },
    },
  );
  throwUserErrors("discountCodeBasicCreate", d.discountCodeBasicCreate.userErrors);
  if (!d.discountCodeBasicCreate.codeDiscountNode) throw new Error("discountCodeBasicCreate returned no node");
  return d.discountCodeBasicCreate.codeDiscountNode.id;
}

export async function deleteDiscount(nodeId: string): Promise<void> {
  const d = await walletGql<{ discountCodeDelete: { userErrors: UserError[] } }>(
    `mutation($id:ID!){ discountCodeDelete(id:$id){ userErrors{ field message } } }`, { id: nodeId });
  // A code Shopify already expired or a customer already used is fine to be gone.
  if (d.discountCodeDelete.userErrors?.some((e) => !/not found|does not exist/i.test(e.message))) throwUserErrors("discountCodeDelete", d.discountCodeDelete.userErrors);
}

// ---- Orders (what the webhooks act on) ------------------------------------

export interface WalletOrder {
  id: string;
  name: string;
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  customerId: string | null;
  phones: string[];
  lines: Array<{ productType: string | null; quantity: number; currentQuantity: number; discountedTotalPaise: number }>;
  /** paise allocated to each discount code on this order, by code */
  codeAllocations: Record<string, number>;
  refundedMerchandisePaise: number;
}

export async function fetchWalletOrder(orderId: string): Promise<WalletOrder | null> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const d = await walletGql<{ order: null | {
    id: string; name: string; cancelledAt: string | null; displayFinancialStatus: string | null; displayFulfillmentStatus: string | null;
    phone: string | null; customer: { id: string; phone: string | null } | null;
    shippingAddress: { phone: string | null } | null; billingAddress: { phone: string | null } | null;
    lineItems: { nodes: Array<{ quantity: number; currentQuantity: number; product: { productType: string | null } | null;
      discountedTotalSet: { shopMoney: { amount: string } };
      discountAllocations: Array<{ allocatedAmountSet: { shopMoney: { amount: string } }; discountApplication: { code?: string } }> }> };
    refunds: Array<{ refundLineItems: { nodes: Array<{ subtotalSet: { shopMoney: { amount: string } }; lineItem: { product: { productType: string | null } | null } }> } }>;
  } }>(
    `query($id:ID!){ order(id:$id){
      id name cancelledAt displayFinancialStatus displayFulfillmentStatus phone
      customer{ id phone } shippingAddress{ phone } billingAddress{ phone }
      lineItems(first:100){ nodes{ quantity currentQuantity product{ productType }
        discountedTotalSet{ shopMoney{ amount } }
        discountAllocations{ allocatedAmountSet{ shopMoney{ amount } } discountApplication{ ... on DiscountCodeApplication { code } } } } }
      refunds{ refundLineItems(first:100){ nodes{ subtotalSet{ shopMoney{ amount } } lineItem{ product{ productType } } } } }
    } }`, { id: gid });
  const o = d.order;
  if (!o) return null;
  const codeAllocations: Record<string, number> = {};
  for (const li of o.lineItems.nodes) {
    for (const a of li.discountAllocations) {
      const code = (a.discountApplication?.code ?? "").toUpperCase();
      if (!code) continue;
      codeAllocations[code] = (codeAllocations[code] ?? 0) + toPaise(a.allocatedAmountSet.shopMoney.amount);
    }
  }
  let refundedMerch = 0;
  for (const r of o.refunds) for (const rl of r.refundLineItems.nodes) {
    if ((rl.lineItem.product?.productType ?? "").toLowerCase() === "service") continue;
    refundedMerch += toPaise(rl.subtotalSet.shopMoney.amount);
  }
  return {
    id: o.id,
    name: o.name,
    cancelledAt: o.cancelledAt,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    customerId: o.customer?.id ?? null,
    phones: [o.customer?.phone, o.phone, o.shippingAddress?.phone, o.billingAddress?.phone].filter((p): p is string => !!p),
    lines: o.lineItems.nodes.map((li) => ({
      productType: li.product?.productType ?? null,
      quantity: li.quantity,
      currentQuantity: li.currentQuantity,
      discountedTotalPaise: toPaise(li.discountedTotalSet.shopMoney.amount),
    })),
    codeAllocations,
    refundedMerchandisePaise: refundedMerch,
  };
}

/** Recent orders for the wallet page, by customer id. */
export async function fetchCustomerOrders(customerId: string, limit = 10): Promise<Array<{ id: string; name: string; createdAt: string; totalPaise: number; financialStatus: string | null; fulfillmentStatus: string | null; statusUrl: string | null }>> {
  const d = await walletGql<{ customer: null | { orders: { nodes: Array<{ id: string; name: string; createdAt: string; statusPageUrl: string | null;
    displayFinancialStatus: string | null; displayFulfillmentStatus: string | null; totalPriceSet: { shopMoney: { amount: string } } }> } } }>(
    `query($id:ID!, $n:Int!){ customer(id:$id){ orders(first:$n, sortKey:CREATED_AT, reverse:true){ nodes{
      id name createdAt statusPageUrl displayFinancialStatus displayFulfillmentStatus totalPriceSet{ shopMoney{ amount } } } } } }`,
    { id: customerId, n: limit });
  return (d.customer?.orders.nodes ?? []).map((o) => ({
    id: o.id, name: o.name, createdAt: o.createdAt, statusUrl: o.statusPageUrl,
    totalPaise: toPaise(o.totalPriceSet.shopMoney.amount),
    financialStatus: o.displayFinancialStatus, fulfillmentStatus: o.displayFulfillmentStatus,
  }));
}

// ---- Webhooks --------------------------------------------------------------

/** Shopify signs webhooks with the subscribing app's client secret. */
export function verifyWebhookHmac(rawBody: string | Buffer, hmacHeader: string | null): boolean {
  if (!hmacHeader) return false;
  const secret = process.env.WALLET_SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_CLIENT_SECRET || "";
  if (!secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest();
  let given: Buffer;
  try { given = Buffer.from(hmacHeader, "base64"); } catch { return false; }
  return given.length === digest.length && timingSafeEqual(given, digest);
}

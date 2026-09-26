import "server-only";

import { randomBytes } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  describeLedgerKind,
  earnAmountPaise,
  earnBasePaise,
  earnReversalPaise,
  isExpired,
  isRedemptionCode,
  redeemablePaise,
  redemptionCodeFrom,
  WALLET_DEFAULTS,
} from "@/lib/wallet-core";
import {
  addCustomerTags,
  createCustomer,
  deleteDiscount,
  fetchWalletOrder,
  findCustomerByPhone,
  mintRedemptionCode,
  type WalletOrder,
} from "@/lib/wallet-shopify";

// The wallet's server side: accounts, the ledger, redemptions, and what each
// Shopify webhook means for them. Every balance change goes through the
// wallet_post_movement RPC (0068), which locks the account and is idempotent
// on (kind, reference) — so this module never does the arithmetic twice and
// a retried webhook is a no-op.

export interface WalletAccount {
  id: string;
  phone: string;
  shopify_customer_id: string | null;
  name: string | null;
  balance_paise: number;
  expires_at: string | null;
  wa_opt_in_at: string | null;
  source: string;
  created_at: string;
}

export interface LedgerRow {
  id: string;
  kind: string;
  amount_paise: number;
  balance_after_paise: number;
  ref_type: string | null;
  ref_id: string | null;
  note: string | null;
  created_at: string;
}

const cfg = () => ({
  welcomePaise: num(process.env.WALLET_WELCOME_PAISE, WALLET_DEFAULTS.welcomePaise),
  earnPercent: num(process.env.WALLET_EARN_PERCENT, WALLET_DEFAULTS.earnPercent),
  minOrderPaise: num(process.env.WALLET_MIN_ORDER_PAISE, WALLET_DEFAULTS.minOrderPaise),
  expiryMonths: num(process.env.WALLET_EXPIRY_MONTHS, WALLET_DEFAULTS.expiryMonths),
});
function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}
export const walletConfig = cfg;

// ---- Accounts ------------------------------------------------------------

export async function getAccountByPhone(phone: string): Promise<WalletAccount | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("wallet_accounts").select("*").eq("phone", phone).maybeSingle<WalletAccount>();
  if (error) throw new Error(`wallet_accounts read: ${error.message}`);
  return data ?? null;
}

export async function getAccountById(id: string): Promise<WalletAccount | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("wallet_accounts").select("*").eq("id", id).maybeSingle<WalletAccount>();
  return data ?? null;
}

/**
 * The one way a wallet comes into being. Creates the row, posts the welcome
 * credit once, and links the Shopify customer if known. Safe to call for an
 * existing phone: returns it unchanged with created=false.
 */
export async function ensureAccount(input: {
  phone: string;
  name?: string | null;
  shopifyCustomerId?: string | null;
  source: "seed" | "popup" | "order" | "manual";
  waOptIn?: boolean;
  welcome?: boolean;
}): Promise<{ account: WalletAccount; created: boolean }> {
  const admin = createAdminClient();
  const existing = await getAccountByPhone(input.phone);
  if (existing) {
    const patch: Partial<WalletAccount> = {};
    if (!existing.shopify_customer_id && input.shopifyCustomerId) patch.shopify_customer_id = input.shopifyCustomerId;
    if (!existing.name && input.name) patch.name = input.name;
    if (!existing.wa_opt_in_at && input.waOptIn) patch.wa_opt_in_at = new Date().toISOString();
    if (Object.keys(patch).length) {
      const { data } = await admin.from("wallet_accounts").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", existing.id).select("*").single<WalletAccount>();
      return { account: data ?? { ...existing, ...patch }, created: false };
    }
    return { account: existing, created: false };
  }
  const { data, error } = await admin
    .from("wallet_accounts")
    .insert({
      phone: input.phone,
      name: input.name ?? null,
      shopify_customer_id: input.shopifyCustomerId ?? null,
      source: input.source,
      wa_opt_in_at: input.waOptIn ? new Date().toISOString() : null,
    })
    .select("*")
    .single<WalletAccount>();
  if (error) {
    // Two requests raced on the same phone: the loser reads the winner's row.
    if (error.code === "23505") {
      const again = await getAccountByPhone(input.phone);
      if (again) return { account: again, created: false };
    }
    throw new Error(`wallet_accounts insert: ${error.message}`);
  }
  let account = data;
  if (input.welcome !== false && cfg().welcomePaise > 0) {
    await postMovement({ accountId: account.id, kind: "welcome", amountPaise: cfg().welcomePaise, refType: "seed", refId: account.phone, note: "Welcome to the Drevi Wallet" });
    account = (await getAccountById(account.id)) ?? account;
  }
  return { account, created: true };
}

/** Link (or create) the Shopify customer for a phone, tagging it for WhatsApp. */
export async function linkShopifyCustomer(input: { phone: string; name?: string | null; tags: string[] }): Promise<string> {
  const found = await findCustomerByPhone(input.phone);
  if (found) {
    const missing = input.tags.filter((t) => !found.tags.includes(t));
    if (missing.length) await addCustomerTags(found.id, missing);
    return found.id;
  }
  const [firstName, ...rest] = (input.name ?? "").trim().split(/\s+/).filter(Boolean);
  const c = await createCustomer({ e164: input.phone, firstName: firstName || null, lastName: rest.join(" ") || null, tags: input.tags, note: "Created by the Drevi Wallet" });
  return c.id;
}

// ---- Ledger ----------------------------------------------------------------

export type MovementKind = "welcome" | "earn" | "redeem" | "reverse_redeem" | "reverse_earn" | "expire" | "adjust";

/** Returns the new ledger row, or null when this (kind, reference) was already posted. */
export async function postMovement(input: {
  accountId: string;
  kind: MovementKind;
  amountPaise: number;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  clamp?: boolean;
}): Promise<LedgerRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("wallet_post_movement", {
    p_account: input.accountId,
    p_kind: input.kind,
    p_amount: Math.trunc(input.amountPaise),
    p_ref_type: input.refType ?? null,
    p_ref_id: input.refId ?? null,
    p_note: input.note ?? null,
    p_clamp: input.clamp ?? false,
    p_expiry_months: cfg().expiryMonths,
  });
  if (error) throw new Error(`wallet_post_movement(${input.kind}): ${error.message}`);
  return (data as LedgerRow | null) ?? null;
}

/** Lazy expiry: if the clock has run out, post the lapse before anyone reads the balance. */
export async function sweepExpiry(account: WalletAccount): Promise<WalletAccount> {
  if (account.balance_paise > 0 && isExpired(account.expires_at)) {
    await postMovement({ accountId: account.id, kind: "expire", amountPaise: -account.balance_paise, refType: "expiry", refId: account.expires_at, clamp: true, note: "Lapsed after 12 months without a credit" });
    return (await getAccountById(account.id)) ?? { ...account, balance_paise: 0 };
  }
  return account;
}

export async function statement(accountId: string, limit = 50): Promise<Array<LedgerRow & { label: string }>> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("wallet_ledger").select("*").eq("account_id", accountId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`wallet_ledger read: ${error.message}`);
  return ((data ?? []) as LedgerRow[]).map((r) => ({ ...r, label: describeLedgerKind(r.kind, r.ref_type, r.ref_id, r.note) }));
}

// ---- Redemptions -----------------------------------------------------------

interface Redemption { id: string; code: string; amount_paise: number; shopify_discount_id: string | null; status: string; expires_at: string; account_id: string }

/** Open, unexpired reservations against the balance. Expires the stale ones on the way. */
export async function reservedPaise(accountId: string): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin.from("wallet_redemptions").select("id, amount_paise, expires_at").eq("account_id", accountId).eq("status", "open");
  let reserved = 0;
  const stale: string[] = [];
  for (const r of (data ?? []) as Array<{ id: string; amount_paise: number; expires_at: string }>) {
    if (new Date(r.expires_at).getTime() < Date.now()) stale.push(r.id);
    else reserved += r.amount_paise;
  }
  if (stale.length) await admin.from("wallet_redemptions").update({ status: "expired" }).in("id", stale);
  return reserved;
}

/**
 * Mint a code for this cart. One open redemption per account: any earlier
 * open one is voided (and its Shopify code deleted) so the customer can't
 * carry two reservations. Nothing is debited yet.
 */
export async function createRedemption(input: { account: WalletAccount; subtotalPaise: number; requestedPaise?: number | null; cartToken?: string | null }): Promise<
  | { ok: true; code: string; amountPaise: number; expiresAt: string }
  | { ok: false; reason: "below_minimum" | "no_balance" | "invalid"; minOrderPaise: number }
> {
  const admin = createAdminClient();
  const c = cfg();
  // Void anything open first, so its amount isn't counted as reserved against itself.
  await voidOpenRedemptions(input.account.id);
  const r = redeemablePaise({ balancePaise: input.account.balance_paise, reservedPaise: 0, subtotalPaise: input.subtotalPaise, requestedPaise: input.requestedPaise, minOrderPaise: c.minOrderPaise });
  if (r.reason !== "ok") return { ok: false, reason: r.reason, minOrderPaise: c.minOrderPaise };

  const code = redemptionCodeFrom(randomBytes(8));
  const expiresAt = new Date(Date.now() + WALLET_DEFAULTS.redemptionTtlSeconds * 1000).toISOString();
  const discountId = await mintRedemptionCode({ code, amountPaise: r.amount, minOrderPaise: c.minOrderPaise });
  const { error } = await admin.from("wallet_redemptions").insert({
    account_id: input.account.id, code, amount_paise: r.amount, shopify_discount_id: discountId, cart_token: input.cartToken ?? null, status: "open", expires_at: expiresAt,
  });
  if (error) {
    await deleteDiscount(discountId).catch(() => {});
    throw new Error(`wallet_redemptions insert: ${error.message}`);
  }
  return { ok: true, code, amountPaise: r.amount, expiresAt };
}

export async function voidOpenRedemptions(accountId: string): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("wallet_redemptions").select("id, shopify_discount_id").eq("account_id", accountId).eq("status", "open");
  for (const r of (data ?? []) as Array<{ id: string; shopify_discount_id: string | null }>) {
    if (r.shopify_discount_id) await deleteDiscount(r.shopify_discount_id).catch(() => {});
    await admin.from("wallet_redemptions").update({ status: "void" }).eq("id", r.id);
  }
}

// ---- Webhooks: what an order event means for a wallet ---------------------

export async function recordWebhookOnce(id: string, topic: string, orderId: string | null): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from("wallet_webhook_events").insert({ id, topic, shopify_order_id: orderId });
  if (error && error.code === "23505") return false;
  if (error) throw new Error(`wallet_webhook_events: ${error.message}`);
  return true;
}

async function accountForOrder(order: WalletOrder): Promise<WalletAccount | null> {
  const { normalizePhone } = await import("@/lib/wallet-core");
  const admin = createAdminClient();
  if (order.customerId) {
    const { data } = await admin.from("wallet_accounts").select("*").eq("shopify_customer_id", order.customerId).maybeSingle<WalletAccount>();
    if (data) return data;
  }
  for (const raw of order.phones) {
    const p = normalizePhone(raw);
    if (!p) continue;
    const a = await getAccountByPhone(p);
    if (a) {
      if (!a.shopify_customer_id && order.customerId) await admin.from("wallet_accounts").update({ shopify_customer_id: order.customerId }).eq("id", a.id);
      return a;
    }
  }
  return null;
}

/**
 * orders/create — the moment a WLT- code becomes a real spend. Debits what
 * Shopify actually allocated to the code (which can be less than minted if
 * the cart shrank), and marks the redemption used.
 */
export async function onOrderCreated(orderId: string): Promise<string> {
  const order = await fetchWalletOrder(orderId);
  if (!order) return "order not found";
  const codes = Object.keys(order.codeAllocations).filter(isRedemptionCode);
  if (!codes.length) {
    // No wallet used — but a first-time buyer should still have a wallet to earn into.
    await ensureAccountForOrder(order);
    return "no wallet code on order";
  }
  const admin = createAdminClient();
  const notes: string[] = [];
  for (const code of codes) {
    const { data: red } = await admin.from("wallet_redemptions").select("*").eq("code", code).maybeSingle<Redemption>();
    if (!red) { notes.push(`${code}: unknown redemption`); continue; }
    const applied = Math.min(red.amount_paise, order.codeAllocations[code] ?? 0);
    if (applied <= 0) { notes.push(`${code}: nothing allocated`); continue; }
    const row = await postMovement({ accountId: red.account_id, kind: "redeem", amountPaise: -applied, refType: "shopify_order", refId: order.id, note: `Used on ${order.name}` });
    await admin.from("wallet_redemptions").update({ status: "used", shopify_order_id: order.id, used_at: new Date().toISOString() }).eq("id", red.id);
    notes.push(`${code}: ${row ? `debited ${applied}` : "already debited"}`);
  }
  return notes.join("; ");
}

async function ensureAccountForOrder(order: WalletOrder): Promise<WalletAccount | null> {
  const existing = await accountForOrder(order);
  if (existing) return existing;
  const { normalizePhone } = await import("@/lib/wallet-core");
  const phone = order.phones.map(normalizePhone).find((p): p is string => !!p);
  if (!phone) return null;
  const { account } = await ensureAccount({ phone, shopifyCustomerId: order.customerId, source: "order" });
  return account;
}

/**
 * orders/paid and orders/fulfilled — the 10% is owed only once BOTH are true,
 * because on a COD order "fulfilled" is the parcel leaving, and "paid" is the
 * customer actually handing over the cash. Idempotent per order.
 */
export async function onOrderPaidOrFulfilled(orderId: string): Promise<string> {
  const order = await fetchWalletOrder(orderId);
  if (!order) return "order not found";
  if (order.cancelledAt) return "cancelled";
  const paid = order.financialStatus === "PAID";
  const fulfilled = order.fulfillmentStatus === "FULFILLED";
  if (!paid || !fulfilled) return `waiting: paid=${paid} fulfilled=${fulfilled}`;
  const account = await ensureAccountForOrder(order);
  if (!account) return "no phone on order";
  const base = earnBasePaise(order.lines.map((l) => ({ productType: l.productType, discountedTotalPaise: l.discountedTotalPaise, quantity: l.quantity, refundedQuantity: l.quantity - l.currentQuantity })));
  const amount = earnAmountPaise(base, cfg().earnPercent);
  if (amount <= 0) return "nothing to earn";
  const row = await postMovement({ accountId: account.id, kind: "earn", amountPaise: amount, refType: "shopify_order", refId: order.id, note: `10% back on ${order.name}` });
  return row ? `earned ${amount}` : "already earned";
}

/** orders/cancelled — spend comes back, earning (if any) goes back. */
export async function onOrderCancelled(orderId: string): Promise<string> {
  const order = await fetchWalletOrder(orderId);
  if (!order) return "order not found";
  const account = await accountForOrder(order);
  if (!account) return "no wallet";
  const admin = createAdminClient();
  const { data: rows } = await admin.from("wallet_ledger").select("kind, amount_paise").eq("account_id", account.id).eq("ref_type", "shopify_order").eq("ref_id", order.id);
  let spent = 0, earned = 0;
  for (const r of (rows ?? []) as Array<{ kind: string; amount_paise: number }>) {
    if (r.kind === "redeem") spent += -r.amount_paise;
    if (r.kind === "reverse_redeem") spent -= r.amount_paise;
    if (r.kind === "earn") earned += r.amount_paise;
    if (r.kind === "reverse_earn") earned += r.amount_paise;
  }
  const notes: string[] = [];
  if (spent > 0) { await postMovement({ accountId: account.id, kind: "reverse_redeem", amountPaise: spent, refType: "shopify_order", refId: order.id, note: `${order.name} cancelled` }); notes.push(`returned ${spent}`); }
  if (earned > 0) { await postMovement({ accountId: account.id, kind: "reverse_earn", amountPaise: -earned, refType: "shopify_order", refId: order.id, note: `${order.name} cancelled`, clamp: true }); notes.push(`reversed earning ${earned}`); }
  return notes.join("; ") || "nothing to reverse";
}

/** refunds/create — claw back only the part of the earning the refund undoes. */
export async function onRefund(orderId: string, refundId: string): Promise<string> {
  const order = await fetchWalletOrder(orderId);
  if (!order) return "order not found";
  const account = await accountForOrder(order);
  if (!account) return "no wallet";
  const admin = createAdminClient();
  const { data: rows } = await admin.from("wallet_ledger").select("kind, amount_paise").eq("account_id", account.id).eq("ref_type", "shopify_order").eq("ref_id", order.id).in("kind", ["earn", "reverse_earn"]);
  const earnedNet = ((rows ?? []) as Array<{ amount_paise: number }>).reduce((s, r) => s + r.amount_paise, 0);
  if (earnedNet <= 0) return "nothing earned to reverse";
  const baseNow = earnBasePaise(order.lines.map((l) => ({ productType: l.productType, discountedTotalPaise: l.discountedTotalPaise, quantity: l.quantity, refundedQuantity: l.quantity - l.currentQuantity })));
  const delta = earnReversalPaise({ earnedNetPaise: earnedNet, baseAfterRefundPaise: baseNow, percent: cfg().earnPercent });
  if (delta >= 0) return "no reversal owed";
  const row = await postMovement({ accountId: account.id, kind: "reverse_earn", amountPaise: delta, refType: "refund", refId: refundId, note: `Refund on ${order.name}`, clamp: true });
  return row ? `reversed ${-delta}` : "already reversed";
}

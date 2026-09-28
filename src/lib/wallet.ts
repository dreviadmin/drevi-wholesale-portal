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
  normalizePhone,
  orderWalletTotals,
  phoneClaimDecision,
  redeemablePaise,
  redemptionCodeFrom,
  refundRef,
  walletReturnOwedPaise,
  WALLET_DEFAULTS,
  type OrderMovement,
} from "@/lib/wallet-core";
import {
  addCustomerTags,
  deleteDiscount,
  fetchWalletOrder,
  getCustomer,
  mintRedemptionCode,
  removeCustomerTags,
  setCustomerNames,
  setCustomerPhone,
  type ShopifyCustomerFull,
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

export async function getAccountByCustomer(customerGid: string): Promise<WalletAccount | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("wallet_accounts").select("*").eq("shopify_customer_id", customerGid)
    .order("created_at", { ascending: true }).limit(1).maybeSingle<WalletAccount>();
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
    // Two tabs raced: both voided nothing and both minted. The unique index
    // on open redemptions (0070) lets exactly one in; the loser hands back
    // the winner's code, so the wallet is never reserved twice.
    if (error.code === "23505") {
      const { data: open } = await admin.from("wallet_redemptions").select("code, amount_paise, expires_at")
        .eq("account_id", input.account.id).eq("status", "open").maybeSingle<{ code: string; amount_paise: number; expires_at: string }>();
      if (open) return { ok: true, code: open.code, amountPaise: open.amount_paise, expiresAt: open.expires_at };
    }
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

/**
 * Every ledger row that belongs to one order: those filed under the order,
 * and those filed under its refunds ("<order>#<refund>"). Cancels and refunds
 * both read this, so neither can undo what the other already did.
 */
async function orderMovements(accountId: string, orderId: string): Promise<OrderMovement[]> {
  const admin = createAdminClient();
  const [direct, viaRefund] = await Promise.all([
    admin.from("wallet_ledger").select("kind, amount_paise").eq("account_id", accountId).eq("ref_type", "shopify_order").eq("ref_id", orderId),
    admin.from("wallet_ledger").select("kind, amount_paise").eq("account_id", accountId).eq("ref_type", "shopify_refund").like("ref_id", `${orderId}#%`),
  ]);
  if (direct.error) throw new Error(`wallet_ledger read: ${direct.error.message}`);
  if (viaRefund.error) throw new Error(`wallet_ledger read: ${viaRefund.error.message}`);
  return [...(direct.data ?? []), ...(viaRefund.data ?? [])] as OrderMovement[];
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
  const base = earnBasePaise(order.lines.map((l) => ({ productType: l.productType, discountedTotalPaise: l.paidPaise, quantity: l.quantity, refundedQuantity: l.quantity - l.currentQuantity })));
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
  const { spentPaise: spent, earnedNetPaise: earned } = orderWalletTotals(await orderMovements(account.id, order.id));
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
  const rows = await orderMovements(account.id, order.id);
  const { spentPaise, earnedNetPaise } = orderWalletTotals(rows);
  const alreadyReturned = rows.filter((r) => r.kind === "reverse_redeem").reduce((s, r) => s + r.amount_paise, 0);
  const ref = refundRef(order.id, refundId);
  const notes: string[] = [];

  // Credit spent on the refunded pieces goes back to the wallet; the refund
  // itself covers only what the customer paid.
  const owed = walletReturnOwedPaise({
    lines: order.lines.map((l) => ({ quantity: l.quantity, refundedQuantity: l.quantity - l.currentQuantity, walletAllocPaise: l.walletAllocPaise })),
    spentPaise, alreadyReturnedPaise: alreadyReturned,
  });
  if (owed > 0) {
    const row = await postMovement({ accountId: account.id, kind: "reverse_redeem", amountPaise: owed, refType: "shopify_refund", refId: ref, note: `Refund on ${order.name}` });
    notes.push(row ? `returned ${owed}` : "already returned");
  }

  if (earnedNetPaise > 0) {
    const baseNow = earnBasePaise(order.lines.map((l) => ({ productType: l.productType, discountedTotalPaise: l.paidPaise, quantity: l.quantity, refundedQuantity: l.quantity - l.currentQuantity })));
    const delta = earnReversalPaise({ earnedNetPaise, baseAfterRefundPaise: baseNow, percent: cfg().earnPercent });
    if (delta < 0) {
      const row = await postMovement({ accountId: account.id, kind: "reverse_earn", amountPaise: delta, refType: "shopify_refund", refId: ref, note: `Refund on ${order.name}`, clamp: true });
      notes.push(row ? `reversed ${-delta}` : "already reversed");
    }
  }
  return notes.join("; ") || "nothing to change";
}

// ---- Signing up and joining (email sign-in) ------------------------------

/** Tags that say "this customer has a wallet"; the theme reads the first. */
export const WALLET_TAGS = ["drevi-wallet", "source:wallet"];

/**
 * Open (or find) the wallet of a SIGNED-IN customer for the phone they give.
 * Sign-in proves the email, not the phone, so phoneClaimDecision decides
 * whether an existing wallet on that phone can be moved here. Also writes
 * the phone, name and WhatsApp choice onto the Shopify customer.
 */
export async function openWalletForCustomer(input: {
  customerGid: string;
  phone: string;
  name?: string | null;
  consent: boolean;
  source: "popup" | "seed" | "order" | "manual";
}): Promise<{ ok: true; account: WalletAccount; created: boolean; phoneReview: boolean } | { ok: false; reason: "invalid_phone" | "phone_in_use" | "no_customer" }> {
  const phone = normalizePhone(input.phone);
  if (!phone) return { ok: false, reason: "invalid_phone" };
  const customer = await getCustomer(input.customerGid);
  if (!customer) return { ok: false, reason: "no_customer" };
  const admin = createAdminClient();
  const name = (input.name ?? "").trim().slice(0, 80) || null;

  let account = await getAccountByCustomer(input.customerGid);
  let created = false;
  let phoneReview = false;

  if (!account) {
    const byPhone = await getAccountByPhone(phone);
    let other: ShopifyCustomerFull | null = null;
    if (byPhone?.shopify_customer_id && byPhone.shopify_customer_id !== input.customerGid) {
      other = await getCustomer(byPhone.shopify_customer_id).catch(() => null);
    }
    const decision = phoneClaimDecision({ walletExists: !!byPhone, walletCustomerId: byPhone?.shopify_customer_id, me: input.customerGid, otherHasEmail: !!other?.email });
    if (decision === "in_use") return { ok: false, reason: "phone_in_use" };
    if (decision === "relink" && byPhone) {
      await admin.from("wallet_accounts").update({ shopify_customer_id: input.customerGid, updated_at: new Date().toISOString() }).eq("id", byPhone.id);
      phoneReview = true;
      if (other) await addCustomerTags(other.id, ["wallet-relinked", "phone-review"]).catch(() => {});
      account = { ...byPhone, shopify_customer_id: input.customerGid };
    } else {
      const r = await ensureAccount({ phone, name, shopifyCustomerId: input.customerGid, source: input.source, waOptIn: input.consent });
      account = r.account;
      created = r.created;
    }
  }

  // The Shopify record: phone (unless another customer holds it), name if
  // empty, and tags the theme and your reports read.
  if ((customer.phone ?? "").replace(/\s/g, "") !== "+" + phone) {
    const r = await setCustomerPhone(input.customerGid, phone).catch((e) => { console.warn("[wallet] set phone:", (e as Error).message); return "taken" as const; });
    if (r === "taken") phoneReview = true;
  }
  if (!customer.firstName && name) {
    const [first, ...rest] = name.split(/\s+/);
    await setCustomerNames(input.customerGid, first, rest.join(" ") || null).catch(() => {});
  }
  const tags = [...WALLET_TAGS, ...(input.consent ? ["wa-opt-in"] : []), ...(phoneReview ? ["phone-review"] : [])];
  await addCustomerTags(input.customerGid, tags).catch((e) => console.warn("[wallet] tags:", (e as Error).message));
  if (!input.consent && customer.tags.includes("wa-opt-in")) await removeCustomerTags(input.customerGid, ["wa-opt-in"]).catch(() => {});

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), wa_opt_in_at: input.consent ? (account.wa_opt_in_at ?? new Date().toISOString()) : null };
  if (!account.name && name) patch.name = name;
  const { data } = await admin.from("wallet_accounts").update(patch).eq("id", account.id).select("*").single<WalletAccount>();
  return { ok: true, account: data ?? account, created, phoneReview };
}

export interface WalletSignup { id: string; email: string; name: string | null; phone: string; wa_opt_in: boolean; created_at: string }

/** Public form budget: 10 per IP and 5 per email in ten minutes. */
export async function signupBudgetOk(ip: string | null, email: string): Promise<boolean> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  if (ip) {
    const { count } = await admin.from("wallet_signups").select("*", { count: "exact", head: true }).eq("ip", ip).gte("created_at", since);
    if ((count ?? 0) >= 10) return false;
  }
  const { count: byEmail } = await admin.from("wallet_signups").select("*", { count: "exact", head: true }).eq("email", email).gte("created_at", since);
  return (byEmail ?? 0) < 5;
}

export async function recordSignup(input: { email: string; name: string | null; phone: string; consent: boolean; ip: string | null; shopifyCustomerId: string | null }): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("wallet_signups").insert({
    email: input.email, name: input.name, phone: input.phone, wa_opt_in: input.consent, ip: input.ip, shopify_customer_id: input.shopifyCustomerId,
  });
  if (error) throw new Error(`wallet_signups insert: ${error.message}`);
}

async function latestUnclaimedSignup(email: string): Promise<WalletSignup | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("wallet_signups").select("id, email, name, phone, wa_opt_in, created_at")
    .eq("email", email.toLowerCase()).is("claimed_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle<WalletSignup>();
  return data ?? null;
}

/**
 * What a signed-in shopper's wallet is, opening it on the way when we can:
 * from the sign-up form they filled before signing in (matched by the email
 * Shopify just verified), or from a phone already on their Shopify record.
 * Otherwise the theme asks for their number.
 */
export async function walletForSignedIn(customerGid: string): Promise<{
  account: WalletAccount | null;
  customer: ShopifyCustomerFull | null;
  reason?: "phone_in_use";
  suggestedPhone?: string | null;
}> {
  const existing = await getAccountByCustomer(customerGid);
  if (existing) return { account: existing, customer: null };
  const customer = await getCustomer(customerGid);
  if (!customer) return { account: null, customer: null };
  const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || null;

  if (customer.email) {
    const s = await latestUnclaimedSignup(customer.email);
    if (s) {
      const r = await openWalletForCustomer({ customerGid, phone: s.phone, name: s.name ?? fullName, consent: s.wa_opt_in, source: "popup" });
      const admin = createAdminClient();
      await admin.from("wallet_signups").update({ claimed_at: new Date().toISOString(), shopify_customer_id: customerGid, claim_note: r.ok ? (r.phoneReview ? "phone-review" : null) : r.reason }).eq("id", s.id);
      if (r.ok) return { account: r.account, customer };
      if (r.reason === "phone_in_use") return { account: null, customer, reason: "phone_in_use", suggestedPhone: s.phone };
    }
  }
  const shopPhone = normalizePhone(customer.phone);
  if (shopPhone) {
    const r = await openWalletForCustomer({ customerGid, phone: shopPhone, name: fullName, consent: customer.tags.includes("wa-opt-in"), source: "popup" });
    if (r.ok) return { account: r.account, customer };
  }
  return { account: null, customer };
}

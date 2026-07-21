"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRawCart, getDetailedCart, type RawCartItem } from "@/lib/cart";
import { getStockState, qtyCap } from "@/lib/stock";
import { finalizeOrder } from "@/lib/order-finalize";
import type { WholesaleProduct, OrderItem } from "@/lib/types";

async function resolveActiveBuyer(): Promise<{ id: string }> {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) throw new Error("Not authenticated");
  const admin = createAdminClient();
  // Emails are no longer unique (migration 0007). The logged-in identity is the
  // credentialed row (setCredentials guarantees at most one per email), so
  // resolve to it explicitly rather than .maybeSingle() (which errors on >1).
  const { data: rows } = await admin
    .from("buyers")
    .select("id, status")
    .eq("email", user.email)
    .not("encrypted_password", "is", null)
    .limit(1);
  const buyer = rows?.[0];
  if (!buyer || buyer.status !== "active") throw new Error("Not an active buyer");
  return { id: buyer.id };
}

async function saveCart(buyerId: string, items: RawCartItem[]): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("carts")
    .upsert({ buyer_id: buyerId, items, updated_at: new Date().toISOString() }, { onConflict: "buyer_id" });
  if (error) throw new Error(`Cart save failed: ${error.message}`);
  revalidatePath("/cart");
  revalidatePath("/catalog");
}

// Clamp a requested qty against the product's stock rules. Returns null if the
// product can't be ordered at all (missing/hidden/sold out).
function clampQty(product: WholesaleProduct | undefined, qty: number): number | null {
  if (!product || !product.wholesale_visible) return null;
  if (getStockState(product) === "sold_out") return null;
  const cap = qtyCap(product);
  const q = Math.max(1, Math.floor(qty));
  return cap != null ? Math.min(q, cap) : q;
}

async function loadProduct(sku: string): Promise<WholesaleProduct | undefined> {
  const admin = createAdminClient();
  const { data } = await admin.from("wholesale_products").select("*").eq("sku", sku).maybeSingle();
  return (data as WholesaleProduct) ?? undefined;
}

export async function addToCart(sku: string, qtyToAdd = 1): Promise<{ ok: boolean; count: number; message?: string }> {
  const buyer = await resolveActiveBuyer();
  const product = await loadProduct(sku);
  const items = await getRawCart(buyer.id);
  const existing = items.find((i) => i.sku === sku);
  const desired = (existing?.qty ?? 0) + qtyToAdd;
  const clamped = clampQty(product, desired);
  if (clamped == null) return { ok: false, count: items.length, message: "This item is no longer available." };

  if (existing) existing.qty = clamped;
  else items.push({ sku, qty: clamped });
  await saveCart(buyer.id, items);
  return { ok: true, count: items.length };
}

export async function setQty(sku: string, qty: number): Promise<{ qty: number }> {
  const buyer = await resolveActiveBuyer();
  let items = await getRawCart(buyer.id);
  let storedQty = 0;
  if (qty <= 0) {
    items = items.filter((i) => i.sku !== sku);
  } else {
    const product = await loadProduct(sku);
    const clamped = clampQty(product, qty);
    const line = items.find((i) => i.sku === sku);
    if (clamped == null) {
      items = items.filter((i) => i.sku !== sku);
    } else if (line) {
      line.qty = clamped;
      line.special = false; // normal adjustment clears any special request
      storedQty = clamped;
    } else {
      items.push({ sku, qty: clamped });
      storedQty = clamped;
    }
  }
  await saveCart(buyer.id, items);
  return { qty: storedQty };
}

/**
 * Client "special quantity request" — stores the exact asked-for qty without
 * MOQ/cap clamping and flags the line. It doesn't reserve stock; Rakesh
 * confirms feasibility when processing the order.
 */
export async function setSpecialQty(sku: string, qty: number): Promise<{ qty: number }> {
  const buyer = await resolveActiveBuyer();
  const items = await getRawCart(buyer.id);
  const product = await loadProduct(sku);
  if (!product || !product.wholesale_visible || getStockState(product) === "sold_out") {
    return { qty: 0 };
  }
  const wanted = Math.max(1, Math.floor(qty));
  const line = items.find((i) => i.sku === sku);
  if (line) {
    line.qty = wanted;
    line.special = true;
  } else {
    items.push({ sku, qty: wanted, special: true });
  }
  await saveCart(buyer.id, items);
  return { qty: wanted };
}

export async function removeFromCart(sku: string): Promise<void> {
  const buyer = await resolveActiveBuyer();
  const items = (await getRawCart(buyer.id)).filter((i) => i.sku !== sku);
  await saveCart(buyer.id, items);
}

export async function clearCart(): Promise<void> {
  const buyer = await resolveActiveBuyer();
  await saveCart(buyer.id, []);
}

export interface SubmitState {
  error?: string;
}

export async function submitOrder(_prev: SubmitState, formData: FormData): Promise<SubmitState> {
  const buyer = await resolveActiveBuyer();
  const note = (formData.get("note")?.toString() ?? "").trim() || null;
  // Client-minted idempotency key: double-taps and flaky-wifi retries resolve
  // to the one order instead of duplicating (audit fix).
  const rawRef = formData.get("clientRef")?.toString().trim() ?? "";
  const clientRef = /^[0-9a-f-]{36}$/i.test(rawRef) ? rawRef : null;

  const cart = await getDetailedCart(buyer.id);
  if (cart.lines.length === 0) return { error: "Your cart is empty." };
  if (cart.hasBlock) return { error: "Some items are below their minimum order quantity. Adjust them (or request a special quantity) before submitting." };

  // Unpriced (₹0) catalog items cannot be self-ordered — the price is on the
  // physical tag only until the sheet is filled (audit fix).
  const unpriced = cart.lines.filter((l) => (l.product.wholesale_price ?? 0) <= 0);
  if (unpriced.length > 0) {
    return { error: `Pricing for ${unpriced.map((l) => l.product.title ?? l.product.sku).join(", ")} is being updated — remove ${unpriced.length === 1 ? "it" : "them"} for now or contact Drevi to order.` };
  }

  if (clientRef) {
    const adminCheck = createAdminClient();
    const { data: existing } = await adminCheck.from("orders").select("id").eq("client_ref", clientRef).maybeSingle();
    if (existing) {
      await saveCart(buyer.id, []);
      redirect(`/order/${existing.id}`);
    }
  }

  const items: OrderItem[] = cart.lines.map((l) => ({
    sku: l.product.sku,
    title: l.product.title ?? l.product.sku,
    unit_price: l.product.wholesale_price,
    qty: l.qty,
    stock_state: l.stockState,
    restock_days: l.stockState === "made_to_order" ? l.product.restock_days : null,
    image_url: l.product.image_urls?.[0] ?? null,
    special_request: l.special || undefined,
  }));

  const admin = createAdminClient();
  // Gapless, race-safe numbering via next_order_number() (migration 0008).
  // Day string in IST — a 1 am order must carry today's Indian date, not UTC's.
  const ymd = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).replace(/-/g, "");

  let orderId: string | null = null;
  for (let attempt = 1; attempt <= 3 && !orderId; attempt++) {
    const { data: numData, error: numErr } = await admin.rpc("next_order_number", { p_prefix: "DW", p_day: ymd });
    if (numErr || !numData) return { error: "Could not generate an order number. Please try again." };
    const order_number = numData as string;
    const { data, error } = await admin
      .from("orders")
      .insert({
        order_number,
        buyer_id: buyer.id,
        status: "submitted",
        source: "portal_self_service",
        items,
        total_amount: cart.subtotal,
        notes: note,
        client_ref: clientRef,
      })
      .select("id")
      .single();
    if (!error && data) orderId = data.id;
    else if (error && error.code === "23505" && clientRef) {
      const { data: won } = await admin.from("orders").select("id").eq("client_ref", clientRef).maybeSingle();
      if (won) { orderId = won.id; break; }
    } else if (error && error.code !== "23505") return { error: `Could not submit order: ${error.message}` };
  }
  if (!orderId) return { error: "Could not generate an order number. Please try again." };

  // Clear the cart BEFORE the slow PDF/Interakt step. If finalize or the
  // redirect times out, the order already exists and the cart is already empty,
  // so a buyer resubmit can't create a duplicate order.
  await saveCart(buyer.id, []);
  await finalizeOrder(orderId); // PDF + Interakt (best-effort)
  redirect(`/order/${orderId}`);
}

"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { getStockState, qtyCap } from "@/lib/stock";
import { finalizeOrder } from "@/lib/order-finalize";
import { sendPendingReviewAlert } from "@/lib/interakt";
import type { WholesaleProduct, OrderItem } from "@/lib/types";

export async function startSession(eventName: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  if (!eventName.trim()) return { ok: false, error: "Event name is required." };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("exhibition_sessions")
    .insert({ event_name: eventName.trim(), started_by: staff.id })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/exhibition");
  return { ok: true, id: data.id };
}

// E3 — capture a new buyer at the booth (pending/exhibition). Most fields are
// optional — capture as much as possible at the booth, complete details later.
export async function captureBuyer(form: {
  business_name?: string;
  owner_name?: string;
  email?: string;
  phone?: string;
  city?: string;
  gstin?: string;
  address?: string;
  transport_details?: string;
  broker_details?: string;
  other_details?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  const email = form.email?.trim().toLowerCase() || null;
  if (!form.owner_name?.trim() && !form.business_name?.trim() && !form.phone?.trim()) {
    return { ok: false, error: "Add at least one of owner name, business name, or phone." };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("buyers")
    .insert({
      email,
      business_name: form.business_name?.trim() || null,
      owner_name: form.owner_name?.trim() || null,
      phone: form.phone?.trim() || null,
      city: form.city?.trim() || null,
      gstin: form.gstin?.trim() || null,
      address: form.address?.trim() || null,
      transport_details: form.transport_details?.trim() || null,
      broker_details: form.broker_details?.trim() || null,
      other_details: form.other_details?.trim() || null,
      status: "pending",
      source: "exhibition",
      captured_by: staff.id,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, error: "A buyer with that email already exists." };
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data.id };
}

// E6 — submit the order on behalf of the buyer.
export async function submitExhibitionOrder(input: {
  sessionId: string;
  eventName: string;
  buyerId: string;
  items: { sku: string; qty: number }[];
  staffNote?: string;
  buyerNote?: string;
}): Promise<{ ok: boolean; orderId?: string; orderNumber?: string; error?: string }> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  if (input.items.length === 0) return { ok: false, error: "Cart is empty." };
  const skus = input.items.map((i) => i.sku);
  const { data: prods } = await admin.from("wholesale_products").select("*").in("sku", skus);
  const bySku = new Map<string, WholesaleProduct>((prods ?? []).map((p) => [p.sku, p as WholesaleProduct]));

  const items: OrderItem[] = [];
  let total = 0;
  for (const it of input.items) {
    const p = bySku.get(it.sku);
    if (!p || !p.wholesale_visible) continue;
    const state = getStockState(p);
    if (state === "sold_out") continue;
    const cap = qtyCap(p);
    const qty = cap != null ? Math.min(it.qty, cap) : Math.max(1, it.qty);
    if (p.min_order_qty != null && qty < p.min_order_qty) {
      return { ok: false, error: `${p.title ?? p.sku} is below its minimum of ${p.min_order_qty}.` };
    }
    items.push({ sku: p.sku, title: p.title ?? p.sku, unit_price: p.wholesale_price, qty, stock_state: state, restock_days: state === "made_to_order" ? p.restock_days : null });
    total += qty * p.wholesale_price;
  }
  if (items.length === 0) return { ok: false, error: "No orderable items." };

  const note = [input.staffNote?.trim() ? `Staff: ${input.staffNote.trim()}` : "", input.buyerNote?.trim() ? `Buyer: ${input.buyerNote.trim()}` : ""].filter(Boolean).join(" | ") || null;

  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const { count } = await admin.from("orders").select("*", { count: "exact", head: true }).like("order_number", `DX-${ymd}-%`);

  let orderId: string | null = null;
  let orderNumber: string | null = null;
  for (let attempt = 1; attempt <= 5 && !orderId; attempt++) {
    const order_number = `DX-${ymd}-${String((count ?? 0) + attempt).padStart(3, "0")}`;
    const { data, error } = await admin
      .from("orders")
      .insert({
        order_number,
        buyer_id: input.buyerId,
        status: "submitted",
        source: "exhibition",
        assisted_by: staff.id,
        exhibition_event: input.eventName,
        items,
        total_amount: total,
        notes: note,
      })
      .select("id")
      .single();
    if (!error && data) { orderId = data.id; orderNumber = order_number; }
    else if (error && error.code !== "23505") return { ok: false, error: error.message };
  }
  if (!orderId) return { ok: false, error: "Could not generate an order number." };

  // bump session order count
  const { data: sess } = await admin.from("exhibition_sessions").select("orders_count").eq("id", input.sessionId).maybeSingle();
  await admin.from("exhibition_sessions").update({ orders_count: (sess?.orders_count ?? 0) + 1 }).eq("id", input.sessionId);

  await finalizeOrder(orderId); // PDF + Interakt (best-effort)
  return { ok: true, orderId, orderNumber: orderNumber ?? undefined };
}

export async function endSession(sessionId: string, eventName: string): Promise<{ ok: boolean }> {
  try { await requireStaff(); } catch { return { ok: false }; }
  const admin = createAdminClient();
  await admin.from("exhibition_sessions").update({ ended_at: new Date().toISOString() }).eq("id", sessionId);
  // Batch alert: pending exhibition captures awaiting Rakesh's review.
  const { count } = await admin.from("buyers").select("*", { count: "exact", head: true }).eq("status", "pending").eq("source", "exhibition");
  if (count && count > 0) await sendPendingReviewAlert(count, eventName);
  revalidatePath("/admin/exhibition");
  return { ok: true };
}

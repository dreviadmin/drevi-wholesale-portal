"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { getStockState } from "@/lib/stock";
import { finalizeOrder } from "@/lib/order-finalize";
import { sendPendingReviewAlert } from "@/lib/interakt";
import type { WholesaleProduct, OrderItem, SessionType, TaxMode, DiscountType } from "@/lib/types";

export async function startSession(
  eventName: string,
  sessionType: SessionType = "exhibition",
): Promise<{ ok: boolean; id?: string; error?: string }> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  if (!eventName.trim()) return { ok: false, error: "Event name is required." };
  const type: SessionType = sessionType === "in_store" ? "in_store" : "exhibition";
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("exhibition_sessions")
    .insert({ event_name: eventName.trim(), started_by: staff.id, session_type: type })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/exhibition");
  return { ok: true, id: data.id };
}

// E3 — capture a new buyer at the booth. Exhibition captures go straight to
// ACTIVE (Ansh, 4 Jul 2026): the staff member vouches on the spot, so no
// separate approval step. (Login still requires credentials to be set later.)
// Most fields are optional — capture what you can, complete details later.
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
      status: "active",
      source: "exhibition",
      captured_by: staff.id,
      approved_by: staff.id,
      approved_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/buyers");
  return { ok: true, id: data.id };
}

// E6 — submit the order on behalf of the buyer.
export async function submitExhibitionOrder(input: {
  sessionId: string;
  eventName: string;
  buyerId: string;
  // qty/unitPrice are the BILLED figures; actualQty (GST bill-split) keeps the
  // real piece count on record. customTitle marks a free-typed piece that is
  // not on the portal — never validated against wholesale_products.
  items: { sku: string; qty: number; unitPrice?: number; actualQty?: number; customTitle?: string }[];
  staffNote?: string;
  buyerNote?: string;
  taxMode?: TaxMode;
  taxRate?: number;
  discountType?: DiscountType;
  discountValue?: number;
  advanceAmount?: number;
  paymentMethod?: string;
  paymentNotes?: string;
}): Promise<{ ok: boolean; orderId?: string; orderNumber?: string; pdfUrl?: string; error?: string }> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  if (input.items.length === 0) return { ok: false, error: "Cart is empty." };

  // Session drives the source + order prefix (exhibition → DX, in-store → IS).
  const { data: sess } = await admin
    .from("exhibition_sessions")
    .select("session_type, event_name, orders_count")
    .eq("id", input.sessionId)
    .maybeSingle();
  const sessionType: SessionType = sess?.session_type === "in_store" ? "in_store" : "exhibition";
  const prefix = sessionType === "in_store" ? "IS" : "DX";
  const eventName = sess?.event_name ?? input.eventName;

  const skus = input.items.map((i) => i.sku);
  const { data: prods } = await admin.from("wholesale_products").select("*").in("sku", skus);
  const bySku = new Map<string, WholesaleProduct>((prods ?? []).map((p) => [p.sku, p as WholesaleProduct]));

  // Staff-assisted orders: MOQ and stock caps are advisory — the order taker
  // can override (they're warned in the UI). Only sold-out/hidden items drop.
  // Staff may also override the unit price per line at billing time.
  const items: OrderItem[] = [];
  let subtotal = 0;
  for (const it of input.items) {
    if (it.customTitle?.trim()) {
      const qty = Math.max(1, Math.floor(it.qty));
      const unitPrice =
        it.unitPrice != null && Number.isFinite(it.unitPrice) && it.unitPrice >= 0 ? Math.round(it.unitPrice * 100) / 100 : 0;
      const actualQty =
        it.actualQty != null && Number.isFinite(it.actualQty) && it.actualQty >= 1 && Math.floor(it.actualQty) !== qty
          ? Math.floor(it.actualQty)
          : null;
      items.push({
        sku: "CUSTOM",
        title: it.customTitle.trim(),
        unit_price: unitPrice,
        qty,
        stock_state: "ready",
        restock_days: null,
        image_url: null,
        custom: true,
        ...(actualQty != null ? { actual_qty: actualQty } : {}),
      });
      subtotal += qty * unitPrice;
      continue;
    }
    const p = bySku.get(it.sku);
    if (!p || !p.wholesale_visible) continue;
    const state = getStockState(p);
    if (state === "sold_out") continue;
    const qty = Math.max(1, Math.floor(it.qty));
    const override = it.unitPrice != null && Number.isFinite(it.unitPrice) && it.unitPrice >= 0 ? Math.round(it.unitPrice * 100) / 100 : null;
    const unitPrice = override ?? p.wholesale_price;
    const actualQty =
      it.actualQty != null && Number.isFinite(it.actualQty) && it.actualQty >= 1 && Math.floor(it.actualQty) !== qty
        ? Math.floor(it.actualQty)
        : null;
    items.push({
      sku: p.sku,
      title: p.title ?? p.sku,
      unit_price: unitPrice,
      qty,
      stock_state: state,
      restock_days: state === "made_to_order" ? p.restock_days : null,
      image_url: p.image_urls?.[0] ?? null,
      ...(override != null && override !== p.wholesale_price ? { original_price: p.wholesale_price } : {}),
      ...(actualQty != null ? { actual_qty: actualQty } : {}),
    });
    subtotal += qty * unitPrice;
  }
  if (items.length === 0) return { ok: false, error: "No orderable items." };

  // Discount — percent or absolute, applied to the subtotal before tax.
  const discountType: DiscountType | null = input.discountType === "percent" || input.discountType === "absolute" ? input.discountType : null;
  let discountValue: number | null = null;
  let discountAmount = 0;
  if (discountType) {
    discountValue = Math.max(0, Number(input.discountValue) || 0);
    discountAmount = discountType === "percent"
      ? Math.round(subtotal * (Math.min(100, discountValue) / 100) * 100) / 100
      : Math.min(subtotal, Math.round(discountValue * 100) / 100);
  }
  const netSubtotal = subtotal - discountAmount;

  // Tax — recomputed server-side; never trust client totals.
  const taxMode: TaxMode = input.taxMode === "inclusive" || input.taxMode === "exclusive" ? input.taxMode : "none";
  let taxRate: number | null = null;
  let taxAmount = 0;
  let total = netSubtotal;
  if (taxMode !== "none") {
    taxRate = Math.min(18, Math.max(5, Number(input.taxRate) || 0));
    if (taxMode === "exclusive") {
      taxAmount = Math.round(netSubtotal * (taxRate / 100) * 100) / 100;
      total = netSubtotal + taxAmount;
    } else {
      // inclusive: prices already carry the tax; extract the component.
      taxAmount = Math.round(netSubtotal * (taxRate / (100 + taxRate)) * 100) / 100;
      total = netSubtotal;
    }
  }

  // Payment
  const advance = Math.max(0, Number(input.advanceAmount) || 0);
  if (advance > total) return { ok: false, error: "Advance cannot exceed the order total." };

  const note = [input.staffNote?.trim() ? `Staff: ${input.staffNote.trim()}` : "", input.buyerNote?.trim() ? `Buyer: ${input.buyerNote.trim()}` : ""].filter(Boolean).join(" | ") || null;

  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

  // Concurrency-safe numbering: the unique index on order_number is the real
  // guard (Postgres/Supabase is fully ACID); on a collision we RE-COUNT so
  // several staff finalising simultaneously converge instead of re-clashing.
  let orderId: string | null = null;
  let orderNumber: string | null = null;
  for (let attempt = 1; attempt <= 8 && !orderId; attempt++) {
    const { count } = await admin.from("orders").select("*", { count: "exact", head: true }).like("order_number", `${prefix}-${ymd}-%`);
    const order_number = `${prefix}-${ymd}-${String((count ?? 0) + attempt).padStart(3, "0")}`;
    const { data, error } = await admin
      .from("orders")
      .insert({
        order_number,
        buyer_id: input.buyerId,
        status: "submitted",
        source: sessionType,
        assisted_by: staff.id,
        exhibition_event: eventName,
        items,
        total_amount: total,
        discount_type: discountType,
        discount_value: discountValue,
        discount_amount: discountAmount,
        tax_mode: taxMode,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        advance_amount: advance,
        payment_method: input.paymentMethod?.trim() || null,
        payment_notes: input.paymentNotes?.trim() || null,
        notes: note,
      })
      .select("id")
      .single();
    if (!error && data) { orderId = data.id; orderNumber = order_number; }
    else if (error && error.code !== "23505") return { ok: false, error: error.message };
  }
  if (!orderId) return { ok: false, error: "Could not generate an order number." };

  // bump session order count
  await admin.from("exhibition_sessions").update({ orders_count: (sess?.orders_count ?? 0) + 1 }).eq("id", input.sessionId);

  await finalizeOrder(orderId); // PDF + Interakt (best-effort)
  const { data: withPdf } = await admin.from("orders").select("pdf_url").eq("id", orderId).maybeSingle();
  return { ok: true, orderId, orderNumber: orderNumber ?? undefined, pdfUrl: withPdf?.pdf_url ?? undefined };
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

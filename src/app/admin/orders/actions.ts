"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/staff";
import { finalizeOrder } from "@/lib/order-finalize";
import { getStockState } from "@/lib/stock";
import type { DiscountType, Order, OrderItem, OrderStatus, TaxMode, WholesaleProduct } from "@/lib/types";

export async function setOrderStatus(
  orderId: string,
  status: OrderStatus,
  options?: { sendInvoice?: boolean },
): Promise<{ ok: boolean; error?: string; invoiceSent?: boolean }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const admin = createAdminClient();

  // Enforce a valid lifecycle server-side (the UI hides buttons, but the action
  // is directly invokable). A cancelled or fulfilled order is terminal — it must
  // not be resurrected to submitted/confirmed, which would re-arm editing and
  // re-fire the buyer's invoice for a dead order.
  const { data: current } = await admin.from("orders").select("status").eq("id", orderId).maybeSingle();
  if (!current) return { ok: false, error: "Order not found." };
  const from = current.status as OrderStatus;
  const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
    submitted: ["confirmed", "cancelled"],
    confirmed: ["fulfilled", "cancelled"],
    fulfilled: [],
    cancelled: [],
  };
  if (from !== status && !ALLOWED[from].includes(status)) {
    return { ok: false, error: `Cannot move a ${from} order to ${status}.` };
  }

  const patch: Record<string, unknown> = { status };
  if (status === "confirmed") patch.confirmed_at = new Date().toISOString();
  const { error } = await admin.from("orders").update(patch).eq("id", orderId);
  if (error) return { ok: false, error: error.message };
  let invoiceSent = false;
  if (options?.sendInvoice) {
    await finalizeOrder(orderId); // best-effort: PDF + Interakt confirmation
    const { data } = await admin.from("orders").select("pdf_sent_at").eq("id", orderId).maybeSingle();
    invoiceSent = !!data?.pdf_sent_at;
  }
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, invoiceSent };
}

// One line of an order amendment: "keep" edits an existing line (matched by
// its position in the stored items array; omitted lines are removed), "add"
// pulls a fresh product in, "custom" is a free-typed piece that isn't on the
// portal. qty/unitPrice are BILLED figures; actualQty keeps the real piece
// count for GST bill-splits.
export type OrderEditLine =
  | { kind: "keep"; index: number; qty: number; unitPrice: number; actualQty?: number | null }
  | { kind: "add"; sku: string; qty: number; unitPrice?: number | null; actualQty?: number | null }
  | { kind: "custom"; title: string; sku?: string; qty: number; unitPrice: number; actualQty?: number | null };

// Full re-bill: the editor can change every billing term the cart page has —
// tax mode/rate, discount, advance and payment. Omitted (undefined) terms keep
// the order's stored values, so line-only edits stay backward compatible.
export interface OrderEditTerms {
  taxMode?: TaxMode;
  taxRate?: number | null;
  discountType?: DiscountType | null;
  discountValue?: number | null;
  advanceAmount?: number;
  paymentMethod?: string | null;
  paymentNotes?: string | null;
}

export async function updateOrderItems(
  orderId: string,
  lines: OrderEditLine[],
  terms?: OrderEditTerms,
): Promise<{ ok: boolean; error?: string; total?: number; overpaidBy?: number }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const admin = createAdminClient();

  const { data: orderRow } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!orderRow) return { ok: false, error: "Order not found." };
  const order = orderRow as Order;
  if (order.status !== "submitted" && order.status !== "confirmed") {
    return { ok: false, error: `A ${order.status} order can no longer be modified.` };
  }
  if (lines.length === 0) return { ok: false, error: "An order needs at least one item — use Cancel instead." };

  // Catalog lookup for added lines + refreshing the original-price marker.
  const skus = [
    ...lines.filter((l): l is Extract<OrderEditLine, { kind: "add" }> => l.kind === "add").map((l) => l.sku),
    ...lines
      .filter((l): l is Extract<OrderEditLine, { kind: "keep" }> => l.kind === "keep")
      .map((l) => order.items[l.index]?.sku)
      .filter(Boolean),
  ];
  const { data: prods } = await admin.from("wholesale_products").select("*").in("sku", skus);
  const bySku = new Map<string, WholesaleProduct>((prods ?? []).map((p) => [p.sku, p as WholesaleProduct]));

  const norm = {
    qty: (n: number) => Math.max(1, Math.floor(Number(n) || 1)),
    price: (n: number) => Math.max(0, Math.round((Number(n) || 0) * 100) / 100),
    // A split's real count is always fewer pieces than the billed count —
    // anything else is malformed and stored as a plain line.
    actual: (n: number | null | undefined, qty: number) =>
      n != null && Number.isFinite(n) && n >= 1 && Math.floor(n) < qty ? Math.floor(n) : null,
  };

  const items: OrderItem[] = [];
  let subtotal = 0;
  for (const line of lines) {
    if (line.kind === "keep") {
      const prev = order.items[line.index];
      if (!prev) return { ok: false, error: "Order changed in another session — reload and retry." };
      const qty = norm.qty(line.qty);
      const unitPrice = norm.price(line.unitPrice);
      // ₹0 is only invalid where it means "unpriced": a custom freebie line or
      // a line that was already stored at ₹0 stays editable.
      if (unitPrice <= 0 && !prev.custom && prev.unit_price > 0) {
        return { ok: false, error: `Set a price for ${prev.title || prev.sku} — a line can't be ₹0.` };
      }
      const actualQty = norm.actual(line.actualQty, qty);
      const catalog = bySku.get(prev.sku);
      const originalPrice =
        catalog != null
          ? catalog.wholesale_price !== unitPrice && catalog.wholesale_price > 0
            ? catalog.wholesale_price
            : undefined
          : prev.original_price;
      items.push({
        ...prev,
        qty,
        unit_price: unitPrice,
        original_price: originalPrice,
        actual_qty: actualQty ?? undefined,
      });
      subtotal += qty * unitPrice;
    } else if (line.kind === "custom") {
      const title = (line.title ?? "").trim();
      if (!title) return { ok: false, error: "A custom item needs a name." };
      const qty = norm.qty(line.qty);
      // Custom lines always carry an explicit price — ₹0 is a legitimate
      // freebie, matching the exhibition submit path.
      const unitPrice = norm.price(line.unitPrice);
      const actualQty = norm.actual(line.actualQty, qty);
      items.push({
        sku: (line.sku ?? "").trim().toUpperCase() || "CUSTOM",
        title,
        unit_price: unitPrice,
        qty,
        stock_state: "ready",
        restock_days: null,
        image_url: null,
        custom: true,
        ...(actualQty != null ? { actual_qty: actualQty } : {}),
      });
      subtotal += qty * unitPrice;
    } else {
      const p = bySku.get(line.sku);
      if (!p || !p.wholesale_visible) return { ok: false, error: `${line.sku} is not orderable.` };
      const state = getStockState(p);
      if (state === "sold_out") return { ok: false, error: `${line.sku} is sold out.` };
      const qty = norm.qty(line.qty);
      const unitPrice = line.unitPrice != null ? norm.price(line.unitPrice) : p.wholesale_price;
      if (unitPrice <= 0) return { ok: false, error: `Set a price for ${p.title ?? p.sku} — a line can't be ₹0.` };
      const actualQty = norm.actual(line.actualQty, qty);
      items.push({
        sku: p.sku,
        title: p.title ?? p.sku,
        unit_price: unitPrice,
        qty,
        stock_state: state,
        restock_days: state === "made_to_order" ? p.restock_days : null,
        image_url: p.image_urls?.[0] ?? null,
        ...(unitPrice !== p.wholesale_price && p.wholesale_price > 0 ? { original_price: p.wholesale_price } : {}),
        ...(actualQty != null ? { actual_qty: actualQty } : {}),
      });
      subtotal += qty * unitPrice;
    }
  }

  // Recompute money server-side — same math as order submission; never trust
  // client totals. Terms the editor sends replace the stored ones; anything
  // omitted keeps the order's existing value.
  const discountType: DiscountType | null =
    terms && "discountType" in terms
      ? terms.discountType === "percent" || terms.discountType === "absolute" ? terms.discountType : null
      : order.discount_type;
  let discountValue: number | null = null;
  let discountAmount = 0;
  if (discountType) {
    const raw = terms && "discountValue" in terms ? terms.discountValue : order.discount_value;
    // Percent stored clamped to 100 so the invoice never prints "(150%)".
    discountValue = discountType === "percent" ? Math.min(100, Math.max(0, Number(raw) || 0)) : Math.max(0, Number(raw) || 0);
    discountAmount =
      discountType === "percent"
        ? Math.round(subtotal * (discountValue / 100) * 100) / 100
        : Math.min(subtotal, Math.round(discountValue * 100) / 100);
  }
  const netSubtotal = subtotal - discountAmount;

  const taxMode: TaxMode =
    terms?.taxMode === "inclusive" || terms?.taxMode === "exclusive" || terms?.taxMode === "none"
      ? terms.taxMode
      : (order.tax_mode ?? "none");
  let taxRate: number | null = null;
  let taxAmount = 0;
  let total = netSubtotal;
  if (taxMode === "exclusive" || taxMode === "inclusive") {
    const rawRate = terms && "taxRate" in terms ? terms.taxRate : order.tax_rate;
    taxRate = Math.min(18, Math.max(5, Number(rawRate) || 5));
    if (taxMode === "exclusive") {
      taxAmount = Math.round(netSubtotal * (taxRate / 100) * 100) / 100;
      total = netSubtotal + taxAmount;
    } else {
      taxAmount = Math.round(netSubtotal * (taxRate / (100 + taxRate)) * 100) / 100;
    }
  }

  const advanceAmount =
    terms && "advanceAmount" in terms ? Math.max(0, Number(terms.advanceAmount) || 0) : Number(order.advance_amount) || 0;
  const paymentMethod =
    terms && "paymentMethod" in terms ? terms.paymentMethod?.trim() || null : order.payment_method;
  const paymentNotes =
    terms && "paymentNotes" in terms ? terms.paymentNotes?.trim() || null : order.payment_notes;

  const { error } = await admin
    .from("orders")
    .update({
      items,
      total_amount: total,
      discount_type: discountType,
      discount_value: discountValue,
      discount_amount: discountAmount,
      tax_mode: taxMode,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      advance_amount: advanceAmount,
      payment_method: advanceAmount > 0 ? paymentMethod : null,
      payment_notes: paymentNotes,
    })
    .eq("id", orderId);
  if (error) return { ok: false, error: error.message };

  // Silent regenerate — do NOT re-notify the buyer for a staff edit.
  await finalizeOrder(orderId, { notify: false });
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);

  // If the edit dropped the total below money already collected, surface the
  // refund owed rather than letting the balance silently clamp to zero.
  const overpaidBy = advanceAmount > total ? Math.round((advanceAmount - total) * 100) / 100 : undefined;
  return { ok: true, total, overpaidBy };
}

// Re-fire the PDF generation + Interakt confirmation send. Used by the
// "Send Invoice" button. Graceful no-op without INTERAKT_API_KEY (PDF still
// regenerated + stored).
export async function sendInvoice(orderId: string): Promise<{ ok: boolean; sent?: boolean; error?: string }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  await finalizeOrder(orderId);
  const admin = createAdminClient();
  const { data } = await admin.from("orders").select("pdf_sent_at, pdf_url").eq("id", orderId).maybeSingle();
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, sent: !!data?.pdf_sent_at };
}

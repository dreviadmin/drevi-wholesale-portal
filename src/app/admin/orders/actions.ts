"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/staff";
import { finalizeOrder } from "@/lib/order-finalize";
import { postOrderMovements, applyMovement } from "@/lib/stock-ledger";
import { getStockState } from "@/lib/stock";
import { storeAuxPhoto } from "@/lib/design-image-store";
import { refreshOrderFromCatalog } from "@/lib/order-catalog-sync";
import { billableLines, pendingLines, computeBillTotals, validateBillDate, billDateToIso, effectiveLineState } from "@/lib/order-lines-core";
import { renderOrderPdf } from "@/lib/order-pdf";
import { uploadOrderPdf } from "@/lib/storage";
import { writeAuditEvent } from "@/lib/audit";
import { formatINR } from "@/lib/format";
import { captureBuyerSnapshot, resolveDocumentParty, snapshotSourceForDate, type BuyerParty } from "@/lib/buyer-snapshot";
import type { AuditEventType, DiscountType, Order, OrderBill, OrderItem, OrderStatus, TaxMode, WholesaleProduct } from "@/lib/types";

export interface StageDetails {
  courier?: string;
  trackingNumber?: string;
  trackingNote?: string;
}

// UX sprint (29 Jul) — the full lifecycle. Stock still moves ONLY at confirm
// (out) and at a post-confirm cancel (back); packed/out-for-delivery/delivered
// are logistics stages, not inventory events. A cancelled / delivered /
// fulfilled order is terminal — it must not be resurrected, which would re-arm
// editing and re-fire the buyer's invoice for a dead order. Orders already
// with the courier cannot be cancelled from here — deliver it or correct
// stock via a movement.
const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  submitted: ["confirmed", "cancelled"],
  confirmed: ["packed", "out_for_delivery", "delivered", "fulfilled", "cancelled"],
  packed: ["out_for_delivery", "delivered", "cancelled"],
  out_for_delivery: ["delivered"],
  delivered: [],
  fulfilled: [],
  cancelled: [],
};

async function applyStatus(
  staffEmail: string,
  orderId: string,
  status: OrderStatus,
  details?: StageDetails,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  const { data: current } = await admin.from("orders").select("status").eq("id", orderId).maybeSingle();
  if (!current) return { ok: false, error: "Order not found." };
  const from = current.status as OrderStatus;
  if (from !== status && !(ALLOWED[from] ?? []).includes(status)) {
    return { ok: false, error: `Cannot move a ${from.replace(/_/g, " ")} order to ${status.replace(/_/g, " ")}.` };
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status };
  // Timestamps only on a real transition — a re-save must not rewrite history.
  if (from !== status) {
    if (status === "confirmed") patch.confirmed_at = now;
    if (status === "packed") patch.packed_at = now;
    if (status === "out_for_delivery") patch.out_for_delivery_at = now;
    if (status === "delivered") patch.delivered_at = now;
  }
  if (details?.courier?.trim()) patch.courier = details.courier.trim();
  if (details?.trackingNumber?.trim()) patch.tracking_number = details.trackingNumber.trim();
  if (details?.trackingNote?.trim()) patch.tracking_note = details.trackingNote.trim();

  // Compare-and-swap on the status we read: two concurrent confirms both pass
  // the gate above, but only the one that wins this UPDATE posts movements —
  // the loser matches zero rows. Without this, stock left the shelf twice.
  const { data: won, error } = await admin
    .from("orders")
    .update(patch)
    .eq("id", orderId)
    .eq("status", from)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!won) return { ok: false, error: "The order changed under you — reload and retry." };

  // §10.1 — movements only on a real TRANSITION, never on a re-save.
  if (from !== status) {
    if (status === "confirmed") await postOrderMovements(orderId, "out", staffEmail);
    // Cancel returns stock from ANY prior state (review fix, 18 Aug): with
    // line-level confirmation, stock can leave while the order is still
    // 'submitted'. postOrderMovements('back') self-guards on stock_moved, so
    // a plain submitted order with nothing moved is a no-op.
    else if (status === "cancelled") await postOrderMovements(orderId, "back", staffEmail);
  }
  return { ok: true };
}

export async function setOrderStatus(
  orderId: string,
  status: OrderStatus,
  options?: { sendInvoice?: boolean; details?: StageDetails },
): Promise<{ ok: boolean; error?: string; invoiceSent?: boolean }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const admin = createAdminClient();

  const applied = await applyStatus(staff.email, orderId, status, options?.details);
  if (!applied.ok) return applied;

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

/**
 * UX sprint — bulk stage change from the orders list. Each order goes through
 * the same lifecycle gate as a single change; invalid transitions are skipped
 * and reported, never forced.
 */
export async function bulkSetOrderStatus(
  orderIds: string[],
  status: OrderStatus,
): Promise<{ ok: boolean; error?: string; done: number; skipped: { orderId: string; error: string }[] }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized.", done: 0, skipped: [] };
  }
  const ids = [...new Set(orderIds)].slice(0, 200);
  if (ids.length === 0) return { ok: false, error: "Nothing selected.", done: 0, skipped: [] };

  let done = 0;
  const skipped: { orderId: string; error: string }[] = [];
  for (const id of ids) {
    const r = await applyStatus(staff.email, id, status);
    if (r.ok) done++;
    else skipped.push({ orderId: id, error: r.error ?? "failed" });
  }
  revalidatePath("/admin/orders");
  return { ok: true, done, skipped };
}

/** UX sprint — tracking-sheet photo for an out-for-delivery order. */
export async function uploadTrackingSheet(
  orderId: string,
  formData: FormData,
): Promise<{ ok: boolean; error?: string; ref?: string }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No photo" };
  if (file.size > 8 * 1024 * 1024) return { ok: false, error: "Photo too large (8 MB max)" };

  const admin = createAdminClient();
  const { data: order } = await admin.from("orders").select("id").eq("id", orderId).maybeSingle();
  if (!order) return { ok: false, error: "Order not found" };

  let ref;
  try {
    ref = await storeAuxPhoto({
      bucket: "order-attachments",
      path: `${orderId}/tracking-${Date.now()}.jpg`,
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "image/jpeg",
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Upload failed" };
  }
  const { error } = await admin.from("orders").update({ tracking_image_ref: ref }).eq("id", orderId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, ref };
}

// One line of an order amendment: "keep" edits an existing line (matched by
// its position in the stored items array; omitted lines are removed), "add"
// pulls a fresh product in, "custom" is a free-typed piece that isn't on the
// portal. qty/unitPrice are BILLED figures; actualQty keeps the real piece
// count for GST bill-splits.
export type OrderEditLine =
  | { kind: "keep"; index: number; qty: number; unitPrice: number; actualQty?: number | null }
  | { kind: "add"; sku: string; qty: number; unitPrice?: number | null; actualQty?: number | null }
  | { kind: "custom"; title: string; sku?: string; qty: number; unitPrice: number; actualQty?: number | null; imageUrl?: string | null };

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
  // "An order, at any stage first of all shall be editable" (Ansh, 21 Sep).
  // Only a cancelled order is closed to edits — that one is history, and its
  // stock has already been returned. 'packed' and 'out_for_delivery' were
  // refused here with no justification at all; 'delivered' and 'fulfilled'
  // were refused because the PDF had shipped, which is an argument for
  // RE-ISSUING the document, not for freezing the record. The real protections
  // are per-line and live below: a billed line, a returned line, and a
  // reduction on goods that already left.
  if (order.status === "cancelled") {
    return { ok: false, error: "A cancelled order can no longer be modified." };
  }
  const shipped = ["out_for_delivery", "delivered", "fulfilled"].includes(order.status);
  const returnedOf = (it: OrderItem | undefined) =>
    Math.max(0, Math.trunc(Number((it as { returned_qty?: number } | undefined)?.returned_qty) || 0));
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
        // Photo of the off-portal piece, snapped in the editor and uploaded to
        // the public custom-items bucket — the invoice PDF fetches this URL.
        image_url: (line.imageUrl ?? "").trim() || null,
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
  // The money TERMS freeze once anything prices off them. computeBillTotals
  // treats an absolute discount as a pot consumed across bills, and a credit
  // note's discountShareFor prorates against the figure that stood when it was
  // raised — move either afterwards and both documents start lying.
  const termKeys = ["discountType", "discountValue", "taxMode", "taxRate"] as const;
  const termsTouched = !!terms && termKeys.some((k) => k in terms);
  if (termsTouched) {
    const [{ count: billCount }, { count: noteCount }] = await Promise.all([
      admin.from("order_bills").select("id", { count: "exact", head: true }).eq("order_id", orderId).is("cancelled_at", null),
      admin.from("credit_notes").select("id", { count: "exact", head: true }).eq("order_id", orderId).eq("status", "issued"),
    ]);
    if ((billCount ?? 0) > 0) {
      return { ok: false, error: "This order has a bill — its discount and tax are fixed by the invoice. Cancel the bill to change them." };
    }
    if ((noteCount ?? 0) > 0) {
      return { ok: false, error: "A credit note was priced off this order's discount and tax — void it before changing them." };
    }
  }

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

  // Split billing (review fixes, 18 Aug):
  //  · a BILLED line is on a printed bill — its qty/price can't change and it
  //    can't be removed from here;
  //  · removing or resizing a line whose stock already left posts the
  //    correcting movement, so the ledger follows the edit;
  //  · the write CASes on lines_rev so a concurrent line-state change (its own
  //    CAS) is never silently clobbered.
  const keptIdx = new Set(
    lines.filter((l): l is Extract<OrderEditLine, { kind: "keep" }> => l.kind === "keep").map((l) => l.index),
  );
  const stockAdjust: { sku: string; delta: number; why: string }[] = [];
  for (let i = 0; i < order.items.length; i++) {
    const prev = order.items[i];
    if (!keptIdx.has(i)) {
      if (prev.billed_in) return { ok: false, error: `${prev.title || prev.sku} is on a bill — billed lines can't be removed. Cancel that bill first.` };
      const back = returnedOf(prev);
      if (back > 0) {
        return { ok: false, error: `${prev.title || prev.sku} has ${back} returned against it on a credit note — void that note before removing the line.` };
      }
      if (shipped && prev.sku && !prev.custom) {
        return { ok: false, error: `${prev.title || prev.sku} has already gone out — take it back with a Return, not an edit. The credit note is what records the money and puts the stock back.` };
      }
      if (prev.stock_moved && prev.sku && !prev.custom) {
        stockAdjust.push({ sku: prev.sku, delta: Math.trunc(Number(prev.qty) || 0), why: "line removed in edit — stock returned" });
      }
    }
  }
  for (const line of lines) {
    if (line.kind !== "keep") continue;
    const prev = order.items[line.index];
    if (!prev) continue;
    const newQty = Math.max(1, Math.floor(Number(line.qty) || 1));
    const newPrice = Math.max(0, Math.round((Number(line.unitPrice) || 0) * 100) / 100);
    if (prev.billed_in && (newQty !== prev.qty || newPrice !== prev.unit_price)) {
      return { ok: false, error: `${prev.title || prev.sku} is on a bill — change the pending lines instead.` };
    }
    const back = returnedOf(prev);
    if (back > 0 && newQty < back) {
      return { ok: false, error: `${prev.title || prev.sku} has ${back} returned against it — it cannot go below that.` };
    }
    if (back > 0 && newPrice !== prev.unit_price) {
      return { ok: false, error: `${prev.title || prev.sku} has a credit note against it at ${formatINR(prev.unit_price)} — repricing it would contradict that note. Void it first.` };
    }
    // Goods that already left come back through a Return, which credits the
    // money and restocks the piece. An edit does neither, so a quiet reduction
    // here would lose both. Increasing is fine — more genuinely went out.
    if (shipped && newQty < prev.qty && prev.sku && !prev.custom) {
      return { ok: false, error: `${prev.title || prev.sku} has already gone out — reduce it with a Return, not an edit.` };
    }
    if (prev.stock_moved && prev.sku && !prev.custom && newQty !== prev.qty) {
      stockAdjust.push({ sku: prev.sku, delta: prev.qty - newQty, why: `qty ${prev.qty}→${newQty} in edit` });
    }
  }

  const currentRev = Number((orderRow as { lines_rev?: number }).lines_rev) || 0;
  const { data: won, error } = await admin
    .from("orders")
    .update({
      items,
      lines_rev: currentRev + 1,
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
    .eq("id", orderId)
    .eq("lines_rev", currentRev)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!won) return { ok: false, error: "The order changed in another session — reload and retry." };

  for (const adj of stockAdjust) {
    if (adj.delta === 0) continue;
    await applyMovement({
      sku: adj.sku, delta: adj.delta, reason: adj.delta > 0 ? "correction" : "order",
      refType: "order", refId: orderId,
      note: `Order ${order.order_number} — ${adj.why}`,
    });
  }

  // Silent regenerate — do NOT re-notify the buyer for a staff edit.
  await finalizeOrder(orderId, { notify: false });
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);

  // If the edit dropped the total below money already collected, surface the
  // refund owed rather than letting the balance silently clamp to zero.
  const creditApplied = Number((order as { credit_applied?: number }).credit_applied) || 0;
  const collected = advanceAmount + creditApplied;
  const overpaidBy = collected > total ? Math.round((collected - total) * 100) / 100 : undefined;
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
  {
    const admin = createAdminClient();
    const { data } = await admin.from("orders").select("status").eq("id", orderId).maybeSingle();
    if (!data) return { ok: false, error: "Order not found." };
    if (data.status === "cancelled") return { ok: false, error: "Cancelled orders are not invoiced." };
  }
  await finalizeOrder(orderId);
  const admin = createAdminClient();
  const { data } = await admin.from("orders").select("pdf_sent_at, pdf_url").eq("id", orderId).maybeSingle();
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, sent: !!data?.pdf_sent_at };
}

/**
 * Ansh (30 Jul) — pull catalog changes (title, photo, HSN) into this order's
 * lines. Never touches qty or prices; custom lines skipped.
 */
export async function syncOrderFromCatalog(orderId: string): Promise<{ ok: boolean; error?: string; touched?: number }> {
  try { await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const r = await refreshOrderFromCatalog(admin, orderId);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, touched: r.touchedSkus?.length ?? 0 };
}

/**
 * Ansh (31 Jul) — add/modify the HSN on ONE line of a placed order. Also
 * fills the product's HSN when the product has none (never overwrites a
 * differing product value — Manage Catalog owns that), so every entered code
 * joins the shared dropdown. Empty value clears the line's code.
 */
export async function setOrderLineHsn(
  orderId: string,
  index: number,
  hsn: string,
): Promise<{ ok: boolean; error?: string }> {
  try { await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const value = hsn.trim().slice(0, 12);
  if (value && !/^[0-9]{2,8}$/.test(value)) return { ok: false, error: "HSN is 2–8 digits." };

  const admin = createAdminClient();
  const { data: order } = await admin.from("orders").select("id, status, items").eq("id", orderId).maybeSingle();
  if (!order) return { ok: false, error: "Order not found." };
  if (order.status === "cancelled") return { ok: false, error: "Cancelled orders are history." };
  const items = [...((order.items ?? []) as OrderItem[])];
  if (index < 0 || index >= items.length) return { ok: false, error: "Line not found — reload the page." };

  items[index] = { ...items[index], hsn: value || null };
  const { error } = await admin.from("orders").update({ items }).eq("id", orderId);
  if (error) return { ok: false, error: error.message };

  const sku = items[index].sku;
  if (value && sku && !(items[index] as { custom?: boolean }).custom) {
    await admin.from("wholesale_products").update({ hsn: value }).eq("sku", sku).is("hsn", null);
  }
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true };
}

// ---- Line-level confirmation + split billing (Ansh, 18 Aug) ---------------
//
// A wholesale customer shares a cart; Rakesh confirms lines that are
// available, holds the rest with an availability note, and bills confirmed
// lines in batches — several bills against one order. Stock moves per LINE at
// confirm; postOrderMovements keys off items[].stock_moved so the whole-order
// Confirm can never double-move a line.

/**
 * Merge a one-index items patch onto a fresh read, CAS-guarded on lines_rev.
 * `expect` re-checks the FRESH item inside the winning write — return an error
 * string to abort (e.g. "already billed"). Returns the item's pre-patch state
 * so callers can decide movements from what actually held when they won —
 * that ordering (win the flag first, then move stock, compensate on failure)
 * is what makes two admins racing the same line safe.
 */
async function patchOrderLine(
  orderId: string,
  index: number,
  patch: Partial<OrderItem>,
  expect?: (fresh: OrderItem) => string | null,
): Promise<{ ok: boolean; error?: string; prev?: OrderItem }> {
  const admin = createAdminClient();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: o } = await admin.from("orders").select("items, lines_rev").eq("id", orderId).maybeSingle();
    if (!o) return { ok: false, error: "Order not found." };
    const items = [...((o.items ?? []) as OrderItem[])];
    if (index < 0 || index >= items.length) return { ok: false, error: "Line not found — reload the page." };
    const prev = items[index];
    if (expect) {
      const bad = expect(prev);
      if (bad) return { ok: false, error: bad };
    }
    items[index] = { ...prev, ...patch };
    const { data: won, error } = await admin
      .from("orders")
      .update({ items, lines_rev: (Number(o.lines_rev) || 0) + 1 })
      .eq("id", orderId)
      .eq("lines_rev", Number(o.lines_rev) || 0)
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (won) return { ok: true, prev };
  }
  return { ok: false, error: "The order changed under you — reload and retry." };
}

export async function setLineState(
  orderId: string,
  index: number,
  state: "confirmed" | "hold" | "pending",
  holdNote?: string,
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  const { data: order } = await admin.from("orders").select("id, order_number, status, items").eq("id", orderId).maybeSingle();
  if (!order) return { ok: false, error: "Order not found." };
  if (["cancelled", "delivered", "fulfilled"].includes(order.status)) {
    return { ok: false, error: "This order is closed — line states can no longer change." };
  }
  const items = (order.items ?? []) as OrderItem[];
  if (index < 0 || index >= items.length) return { ok: false, error: "Line not found — reload the page." };
  const it = items[index];
  if (it.billed_in) return { ok: false, error: "This line is already billed — it can't change state." };

  const note = holdNote?.trim().slice(0, 300) || null;
  const movable = !!it.sku && !it.custom && Math.trunc(Number(it.qty) || 0) > 0;
  const qty = Math.trunc(Number(it.qty) || 0);

  // Flag first, movement second (review fix, 18 Aug): the CAS write is the
  // arbiter, so two admins racing the same line can't both post a movement —
  // the loser's fresh read sees the flag already flipped. A movement failure
  // after a won flag write compensates by putting the flag back.
  const guardUnbilled = (fresh: OrderItem) =>
    fresh.billed_in ? "This line is already billed — it can't change state." :
    fresh.sku !== it.sku ? "The order changed under you — reload and retry." : null;

  if (state === "confirmed") {
    const w = await patchOrderLine(
      orderId, index,
      { line_state: "confirmed", hold_note: null, ...(movable ? { stock_moved: true } : {}) },
      guardUnbilled,
    );
    if (!w.ok) return w;
    if (movable && !w.prev?.stock_moved) {
      const res = await applyMovement({
        sku: it.sku, delta: -qty, reason: "order", refType: "order", refId: orderId,
        note: `Order ${order.order_number} — line ${it.sku} confirmed`, createdBy: staff.email,
      });
      if (!res.ok) {
        await patchOrderLine(orderId, index, { line_state: w.prev?.line_state ?? null, stock_moved: false });
        return { ok: false, error: res.error ?? "Stock movement failed — the line was left unconfirmed." };
      }
    }
  } else {
    const w = await patchOrderLine(
      orderId, index,
      {
        // 'pending' is stored explicitly — a null on a confirmed order would
        // derive straight back to confirmed (review fix, 18 Aug).
        line_state: state === "hold" ? "hold" : "pending",
        hold_note: state === "hold" ? note : null,
        stock_moved: false,
      },
      guardUnbilled,
    );
    if (!w.ok) return w;
    // The line's stock had actually left (per the state we won on) — bring it back.
    if (movable && w.prev?.stock_moved) {
      const res = await applyMovement({
        sku: it.sku, delta: qty, reason: "correction", refType: "order", refId: orderId,
        note: `Order ${order.order_number} — line ${it.sku} un-confirmed, stock returned`, createdBy: staff.email,
      });
      if (!res.ok) {
        await patchOrderLine(orderId, index, { line_state: "confirmed", stock_moved: true });
        return { ok: false, error: res.error ?? "Stock movement failed — the line stays confirmed." };
      }
    }
  }

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/dashboard");
  return { ok: true };
}

/** A bill as stored — everything renderOrderPdf needs, nothing recomputed. */
type BillForPdf = Pick<
  OrderBill,
  "id" | "bill_number" | "seq" | "bill_date" | "items" | "discount_amount" | "tax_mode" | "tax_rate" | "tax_amount" | "total" | "advance_applied"
>;

/**
 * Render + store one bill's PDF. Best-effort: the bill row already stands, so a
 * render failure is logged and never rolls anything back. Shared with
 * recaptureDocumentParty so a corrected party reaches the FILE the buyer was
 * sent, not only the columns.
 */
async function renderAndStoreBillPdf(order: Order, bill: BillForPdf, party: BuyerParty): Promise<string | undefined> {
  const admin = createAdminClient();
  try {
    const after = { ...order, items: (await admin.from("orders").select("items").eq("id", order.id).single()).data?.items ?? order.items };
    const synthetic: Order = {
      ...order,
      order_number: bill.bill_number,
      items: bill.items,
      total_amount: bill.total,
      discount_type: bill.discount_amount > 0 ? order.discount_type : null,
      discount_value: bill.discount_amount > 0 ? order.discount_value : null,
      discount_amount: bill.discount_amount,
      tax_mode: bill.tax_mode,
      tax_rate: bill.tax_rate,
      tax_amount: bill.tax_amount,
      advance_amount: bill.advance_applied,
      submitted_at: billDateToIso(bill.bill_date),
    };
    const pdf = await renderOrderPdf(synthetic, party, {
      seq: bill.seq,
      orderNumber: order.order_number,
      pendingCount: pendingLines(after as Order).length,
    });
    const pdfUrl = await uploadOrderPdf(order.id, bill.bill_number, pdf);
    await admin.from("order_bills").update({ pdf_url: pdfUrl }).eq("id", bill.id);
    return pdfUrl;
  } catch (e) {
    console.error("bill PDF failed (bill stands; regenerate from the order page):", (e as Error).message);
    return undefined;
  }
}

/**
 * Bill every confirmed-and-unbilled line as one new bill. `billDate` may be a
 * past date (never future). The order itself keeps its status — billing and
 * the logistics lifecycle stay independent.
 */
export async function generateOrderBill(
  orderId: string,
  opts: { billDate?: string } = {},
): Promise<{ ok: boolean; error?: string; billNumber?: string; pdfUrl?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  const { data: order } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!order) return { ok: false, error: "Order not found." };
  const o = order as Order;
  if (o.status === "cancelled") return { ok: false, error: "Cancelled orders can't be billed." };

  const billable = billableLines(o);
  if (billable.length === 0) return { ok: false, error: "No confirmed, unbilled lines — confirm something first." };

  const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const billDate = opts.billDate ? validateBillDate(opts.billDate, todayIst) : todayIst;
  if (!billDate) return { ok: false, error: "Bill date must be a valid date, today or earlier." };

  const { data: prevBills } = await admin
    .from("order_bills")
    .select("seq, discount_amount, advance_applied")
    .eq("order_id", orderId)
    .order("seq", { ascending: false });
  const prior = {
    discountApplied: (prevBills ?? []).reduce((s, b) => s + (Number(b.discount_amount) || 0), 0),
    advanceApplied: (prevBills ?? []).reduce((s, b) => s + (Number(b.advance_applied) || 0), 0),
  };
  const lines = billable.map((b) => b.item);
  const totals = computeBillTotals(lines, o, prior);

  // Freeze the party onto THIS bill (migration 0047). B2 legitimately differs
  // from B1 if the party changed in between — each bill states who was billed
  // on its own date, and no later edit to the buyers row moves it. A bill dated
  // to the past stamps today's identity on an earlier date, so it says so.
  const source = snapshotSourceForDate(billDate, todayIst);
  const party = await captureBuyerSnapshot(admin, o.buyer_id, source);

  // Reserve the bill row (unique (order_id, seq) absorbs races).
  let bill: { id: string; bill_number: string; seq: number } | null = null;
  for (let attempt = 0; attempt < 3 && !bill; attempt++) {
    const seq = (prevBills?.[0]?.seq ?? 0) + 1 + attempt;
    const bill_number = `${o.order_number}-B${seq}`;
    const { data, error } = await admin
      .from("order_bills")
      .insert({
        order_id: orderId, bill_number, seq, items: lines,
        subtotal: totals.subtotal, discount_amount: totals.discountAmount,
        tax_mode: totals.taxMode, tax_rate: totals.taxRate, tax_amount: totals.taxAmount,
        total: totals.total, advance_applied: totals.advanceApplied,
        bill_date: billDate, created_by: staff.email,
        ...party,
      })
      .select("id, bill_number, seq")
      .single();
    if (data) bill = data;
    else if (error && error.code !== "23505") return { ok: false, error: error.message };
  }
  if (!bill) return { ok: false, error: "Could not reserve a bill number — retry." };

  // Mark the billed lines. Each write re-verifies the FRESH line is still the
  // same SKU, still confirmed and still unbilled — a hold landing mid-billing,
  // a Modify-Order reshuffle, or a racing second Generate-bill click all abort
  // here. On abort: un-mark what we already marked, delete OUR bill, error out.
  const marked: number[] = [];
  for (const { index, item } of billable) {
    const w = await patchOrderLine(orderId, index, { billed_in: bill.id }, (fresh) =>
      fresh.sku !== item.sku ? "The order's lines changed while billing." :
      fresh.billed_in ? "A line was already billed (another bill just went through?)." :
      effectiveLineState(fresh, o.status) !== "confirmed" ? "A line changed state while billing." : null,
    );
    if (!w.ok) {
      for (const idx of marked) await patchOrderLine(orderId, idx, { billed_in: null });
      await admin.from("order_bills").delete().eq("id", bill.id);
      return { ok: false, error: `${w.error ?? "Order changed while billing"} — nothing was billed, reload and retry.` };
    }
    marked.push(index);
  }

  // Print what was just frozen, never a live buyers read — that read was the
  // whole bug: it rewrote every bill this party had ever been issued.
  const pdfUrl = await renderAndStoreBillPdf(
    o,
    {
      id: bill.id, bill_number: bill.bill_number, seq: bill.seq, bill_date: billDate, items: lines,
      discount_amount: totals.discountAmount, tax_mode: totals.taxMode, tax_rate: totals.taxRate,
      tax_amount: totals.taxAmount, total: totals.total, advance_applied: totals.advanceApplied,
    },
    await resolveDocumentParty(admin, party, o.buyer_id),
  );

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/dashboard");
  return { ok: true, billNumber: bill.bill_number, pdfUrl };
}

// ---- Correcting a frozen party (13 Sep) ------------------------------------
//
// Freezing the party at issue is right for an identity that CHANGED, and wrong
// for one that was simply typed wrong — and a frozen column removes the only
// way staff had to fix that. This is the way back: an admin corrects the buyers
// row (Edit Details), then re-stamps this order and its bills from it. It is
// deliberately per-order and audited, because it rewrites what a tax document
// says its recipient was.

/** The six party fields, in the order the audit note reads them out. */
const PARTY_FIELD_LABELS: [keyof BuyerParty, string][] = [
  ["business_name", "business"],
  ["owner_name", "owner"],
  ["phone", "phone"],
  ["city", "city"],
  ["gstin", "GSTIN"],
  ["address", "address"],
];

export async function recaptureDocumentParty(
  orderId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string; bills?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }

  const clean = (reason ?? "").trim().slice(0, 300);
  if (!clean) return { ok: false, error: "Say what was wrong with the party on this document." };

  const admin = createAdminClient();
  const { data: orderRow } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!orderRow) return { ok: false, error: "Order not found." };
  const o = orderRow as Order;
  if (!o.buyer_id) return { ok: false, error: "This order has no party to re-read." };

  // What the documents print TODAY — the honest "before" for the audit note,
  // including the live fallback for a row that predates its snapshot.
  const before = await resolveDocumentParty(admin, o, o.buyer_id);
  const party = await captureBuyerSnapshot(admin, o.buyer_id, "recapture");
  const after: BuyerParty = {
    business_name: party.buyer_business_name,
    owner_name: party.buyer_owner_name,
    phone: party.buyer_phone,
    city: party.buyer_city,
    gstin: party.buyer_gstin,
    address: party.buyer_address,
  };
  const replaced =
    PARTY_FIELD_LABELS.filter(([k]) => (before[k] ?? "") !== (after[k] ?? ""))
      .map(([k, label]) => `${label}: ${before[k] ?? "(empty)"} -> ${after[k] ?? "(empty)"}`)
      .join("; ") || "no field differed";

  const { error } = await admin.from("orders").update(party).eq("id", orderId);
  if (error) return { ok: false, error: error.message };

  // The bills carry their own copy, so they have to be re-stamped too —
  // otherwise the order says one party and its invoices say another.
  const { data: billRows, error: billErr } = await admin
    .from("order_bills")
    .update(party)
    .eq("order_id", orderId)
    .select("id, bill_number, seq, bill_date, items, discount_amount, tax_mode, tax_rate, tax_amount, total, advance_applied");
  if (billErr) return { ok: false, error: billErr.message };
  const bills = (billRows ?? []) as BillForPdf[];

  await writeAuditEvent({
    eventType: "document_party_recaptured",
    buyerId: o.buyer_id,
    staffUserId: staff.id,
    notes: `${o.order_number}${bills.length > 0 ? ` + ${bills.length} bill${bills.length === 1 ? "" : "s"}` : ""} — ${clean} — ${replaced}`,
  });

  // Re-render the files themselves: a corrected column the buyer never sees is
  // not a correction. Silent — a staff fix must not re-fire the buyer's invoice.
  const fixed = { ...o, ...party };
  for (const bill of bills) await renderAndStoreBillPdf(fixed, bill, after);
  await finalizeOrder(orderId, { notify: false });

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/buyers/${o.buyer_id}`);
  return { ok: true, bills: bills.length };
}


// ---- Date corrections (14 Sep) ---------------------------------------------
//
// Back-dated entry (18 Aug) lets a sale be recorded on the day it happened.
// These two are the way back when that day was recorded wrong, and they are two
// actions rather than one because the documents are not symmetric: a bill
// number encodes no date and can simply be re-dated, while an order number
// encodes its own day and cannot be reissued at all.

/** IST day string — the day a document belongs to, never UTC's. */
function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * audit_event_type is a Postgres ENUM (0001_init), so a dedicated
 * 'document_date_corrected' value needs a migration this change does not own.
 * Until that lands both corrections are written under the nearest existing
 * document-correction value with the kind leading the note, because a row
 * inserted under an unknown label is rejected and writeAuditEvent swallows the
 * failure — a mandatory audit trail would go missing silently.
 */
const DATE_CORRECTION_EVENT: AuditEventType = "document_date_corrected";

/**
 * Re-date one bill. The safe half of the pair: a bill number carries no date,
 * so nothing printed contradicts the new one.
 *
 * Two bounds hold it inside its own lineage — it may not predate the sale it
 * bills, and it may not outlive a credit note that reverses it — and the
 * denormalised copy the credit note PRINTS (source_bill_date) moves with it.
 */
export async function setBillDate(
  billId: string,
  newDate: string,
  reason: string,
): Promise<{ ok: boolean; error?: string; billDate?: string; notes?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }

  const clean = (reason ?? "").trim().slice(0, 300);
  if (!clean) return { ok: false, error: "Say why this bill's date is being corrected." };

  const admin = createAdminClient();
  const { data: billRow } = await admin.from("order_bills").select("*").eq("id", billId).maybeSingle();
  if (!billRow) return { ok: false, error: "Bill not found." };
  const b = billRow as OrderBill;

  const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const billDate = validateBillDate(newDate, todayIst);
  if (!billDate) return { ok: false, error: "Bill date must be a valid date, today or earlier." };
  if (billDate === b.bill_date) return { ok: false, error: "That is already this bill's date." };

  const { data: orderRow } = await admin.from("orders").select("*").eq("id", b.order_id).maybeSingle();
  if (!orderRow) return { ok: false, error: "Order not found." };
  const o = orderRow as Order;
  if (o.status === "cancelled") return { ok: false, error: "Cancelled orders are history — their bills keep their dates." };

  const orderDay = istDay(o.submitted_at);
  if (billDate < orderDay) {
    return { ok: false, error: `${o.order_number} is dated ${orderDay} — a bill cannot be dated before its own sale.` };
  }

  // credit_notes carries source_bill_date denormalised because the note PRINTS
  // it ("Against invoice ... dated ..."), so that copy has to travel with the
  // bill. A note that reverses this bill cannot predate it either.
  const { data: noteRows } = await admin
    .from("credit_notes")
    .select("id, note_number, note_date, status")
    .eq("order_bill_id", billId);
  const notes = (noteRows ?? []) as { id: string; note_number: string; note_date: string; status: string }[];
  const reversedEarlier = notes.find((n) => n.status === "issued" && n.note_date < billDate);
  if (reversedEarlier) {
    return {
      ok: false,
      error: `${reversedEarlier.note_number} credits this bill on ${reversedEarlier.note_date} — the bill cannot be dated after the note that reverses it.`,
    };
  }

  const { error } = await admin.from("order_bills").update({ bill_date: billDate }).eq("id", billId);
  if (error) return { ok: false, error: error.message };

  if (notes.length > 0) {
    const { error: cascadeErr } = await admin
      .from("credit_notes")
      .update({ source_bill_date: billDate })
      .eq("order_bill_id", billId);
    // Half a correction is worse than none: a note quoting a date its bill no
    // longer states reads as two different invoices. Put the bill back.
    if (cascadeErr) {
      await admin.from("order_bills").update({ bill_date: b.bill_date }).eq("id", billId);
      return { ok: false, error: `The credit notes quoting this bill could not be re-dated (${cascadeErr.message}) — nothing was changed.` };
    }
  }

  await writeAuditEvent({
    eventType: DATE_CORRECTION_EVENT,
    buyerId: o.buyer_id,
    staffUserId: staff.id,
    notes:
      `bill date corrected — ${b.bill_number}: ${b.bill_date} -> ${billDate}` +
      `${notes.length > 0 ? ` · ${notes.length} credit note${notes.length === 1 ? "" : "s"} re-referenced` : ""} — ${clean}`,
  });

  // The date is printed, so a corrected column the buyer never sees is not a
  // correction (the same rule 0047's party re-stamp follows). Reprints the
  // party frozen on the BILL, never a live buyers read.
  await renderAndStoreBillPdf(o, { ...b, bill_date: billDate }, await resolveDocumentParty(admin, b, o.buyer_id));

  revalidatePath(`/admin/orders/${b.order_id}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/credit-notes");
  return { ok: true, billDate, notes: notes.length };
}

/**
 * Re-date one order. Allowed, but honest about what it cannot do: the order
 * number encodes the day (DX-20260717-014), is issued gaplessly by
 * next_order_number (0008) and is already printed on PDFs the buyer holds, so
 * it is NOT reissued — the order ends up dated differently from its own number.
 * Moving it across an IST day also moves it between dashboard and report
 * buckets, which key on submitted_at. The dialog states both before the call;
 * the audit note records old -> new -> reason.
 */
export async function setOrderDate(
  orderId: string,
  newDate: string,
  reason: string,
): Promise<{ ok: boolean; error?: string; orderDate?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }

  const clean = (reason ?? "").trim().slice(0, 300);
  if (!clean) return { ok: false, error: "Say why this order's date is being corrected." };

  const admin = createAdminClient();
  const { data: orderRow } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!orderRow) return { ok: false, error: "Order not found." };
  const o = orderRow as Order;
  if (o.status === "cancelled") return { ok: false, error: "Cancelled orders are history — their date stands." };

  const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const orderDate = validateBillDate(newDate, todayIst);
  if (!orderDate) return { ok: false, error: "Order date must be a valid date, today or earlier." };
  const before = istDay(o.submitted_at);
  if (orderDate === before) return { ok: false, error: "That is already this order's date." };

  // A bill is dated on or after the sale it bills, so the order can only move
  // forward as far as the first bill raised against it — setBillDate is how
  // that ceiling itself gets moved.
  const { data: billRows } = await admin
    .from("order_bills")
    .select("bill_number, bill_date")
    .eq("order_id", orderId)
    .order("bill_date")
    .limit(1);
  const firstBill = billRows?.[0] as { bill_number: string; bill_date: string } | undefined;
  if (firstBill && orderDate > firstBill.bill_date) {
    return { ok: false, error: `${firstBill.bill_number} is dated ${firstBill.bill_date} — the order cannot start after the first bill raised against it.` };
  }

  // Noon IST, exactly as back-dated entry stores it, so IST day-bucketing
  // cannot drift by a timezone hour.
  const { error } = await admin.from("orders").update({ submitted_at: billDateToIso(orderDate) }).eq("id", orderId);
  if (error) return { ok: false, error: error.message };

  await writeAuditEvent({
    eventType: DATE_CORRECTION_EVENT,
    buyerId: o.buyer_id,
    staffUserId: staff.id,
    notes:
      `order date corrected — ${o.order_number}: ${before} -> ${orderDate} — ${clean} — ` +
      "the order number encodes its original day, is gapless and was already printed, so it was not reissued; " +
      "dashboard and report buckets move with submitted_at",
  });

  // submitted_at is what the order's own PDF prints as its date. Silent: a
  // staff correction must not re-fire the buyer's confirmation message.
  await finalizeOrder(orderId, { notify: false });

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/dashboard");
  revalidatePath(`/admin/buyers/${o.buyer_id}`);
  return { ok: true, orderDate };
}

/**
 * Record a payment received against an order (Ansh, 21 Sep: "after an order is
 * fulfilled there shall be an option to record payment ... VALLABHAM had
 * payment due which they have paid, but there's no option to mark payment").
 *
 * WHY THIS IS NOT PART OF THE ORDER EDITOR. orders.advance_amount had exactly
 * one writer — updateOrderItems, through the editor — and OrderEditor returns
 * null past 'confirmed'. So the moment an order was delivered or fulfilled,
 * the money it was still owed became unrecordable. DX-20260717-017 sat
 * 'fulfilled' with ₹33,501.51 outstanding and nowhere to enter it.
 *
 * It is the same mistake the order page already calls out for billing:
 * "billing does not belong to the logistics lifecycle at all". Neither does
 * payment. A balance is normally settled AFTER delivery — that is what a
 * balance is — so this refuses only 'cancelled', exactly as
 * generateOrderBill does, and is indifferent to every other status.
 *
 * ADDITIVE, not a setter: advance_amount is the cumulative total received, so
 * a part payment adds to it rather than replacing it. There is no payments
 * table to hold a history, so each receipt appends a dated, attributed line to
 * payment_notes — which is the visible record on the order — and the audit
 * event carries the same facts centrally.
 */
export async function recordPayment(
  orderId: string,
  input: { amount: number; method: string; note?: string },
): Promise<{ ok: boolean; error?: string; advance?: number; balance?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }

  const admin = createAdminClient();
  const { data: orderRow } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!orderRow) return { ok: false, error: "Order not found." };
  const o = orderRow as Order;
  if (o.status === "cancelled") return { ok: false, error: "This order is cancelled — nothing is owed on it." };

  const method = (input.method ?? "").trim().slice(0, 40);
  if (!method) return { ok: false, error: "How was it paid? Cash, bank transfer, UPI, cheque…" };

  const advance = Number(o.advance_amount) || 0;
  const credit = Number((orderRow as Record<string, unknown>).credit_applied ?? 0) || 0;
  const balance = Math.round(Math.max(0, (Number(o.total_amount) || 0) - advance - credit) * 100) / 100;
  if (balance <= 0) return { ok: false, error: "This order is already settled in full." };

  const amount = Math.round((Number(input.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return { ok: false, error: "Enter the amount received." };
  // Refused, not clamped: more than the balance is a typo far more often than
  // it is a gift, and silently keeping the difference would hide it.
  if (amount > balance) {
    return { ok: false, error: `That is more than the ${formatINR(balance)} outstanding — enter ${formatINR(balance)} or less.` };
  }

  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  const clean = (input.note ?? "").trim().slice(0, 200);
  const line = `${today} · ${formatINR(amount)} by ${method}${clean ? ` · ${clean}` : ""} · recorded by ${staff.email}`;
  const notes = [o.payment_notes?.trim(), line].filter(Boolean).join("\n").slice(0, 2000);

  const nextAdvance = Math.round((advance + amount) * 100) / 100;
  const { data: won, error } = await admin
    .from("orders")
    .update({
      advance_amount: nextAdvance,
      // Singular column, so it holds the LATEST method; the appended note is
      // what keeps a mixed-tender history readable.
      payment_method: method,
      payment_notes: notes,
    })
    .eq("id", orderId)
    // Guard the read-modify-write: two people recording a payment at once must
    // not each add to the same starting figure. credit_applied is in the
    // predicate too, because settling a return against this order moves the
    // balance this function just read.
    .eq("advance_amount", advance)
    .eq("credit_applied", credit)
    // .select().maybeSingle() is the whole point (21 Sep): a PostgREST update
    // that matches ZERO rows returns no error, so the original
    // `const { error } = ...` reported ok:true on a LOST compare-and-set and
    // went on to write an audit event saying the money had landed. The guard
    // was decorative — this is what makes it a guard.
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!won) {
    return {
      ok: false,
      error: "This order's payment or credit changed in another session — reload and check the balance before entering this again.",
    };
  }

  await writeAuditEvent({
    eventType: "order_payment_recorded",
    buyerId: o.buyer_id,
    staffUserId: staff.id,
    notes: `payment recorded — ${o.order_number}: ${formatINR(amount)} by ${method}${clean ? ` (${clean})` : ""}; advance ${formatINR(advance)} → ${formatINR(nextAdvance)}, balance now ${formatINR(Math.max(0, balance - amount))}`,
  });

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/dashboard");
  revalidatePath(`/admin/buyers/${o.buyer_id}`);
  return { ok: true, advance: nextAdvance, balance: Math.round(Math.max(0, balance - amount) * 100) / 100 };
}

/**
 * Cancel a bill without touching the order (Ansh, 21 Sep — asked for exactly
 * this: "cancel the bill, not the order").
 *
 * A tax invoice is not deleted, it is cancelled and KEPT, the same way a credit
 * note is voided rather than edited. The row survives with who cancelled it and
 * why; the order's lines are released back to the order path so they can be
 * billed again or returned against the order itself.
 *
 * No stock is touched: generateOrderBill posts no movements, so there is
 * nothing to reverse. It refuses while a live credit note still cites the
 * bill — that note's "against invoice X" line would be naming a cancelled
 * document.
 *
 * This also finally makes true the error message at the top of
 * updateOrderItems, which has told staff to "Cancel that bill first" since
 * August while naming an action nobody could perform.
 */
export async function cancelBill(
  billId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string; billNumber?: string; linesFreed?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }

  const clean = (reason ?? "").trim().slice(0, 300);
  if (!clean) return { ok: false, error: "Say why this bill is being cancelled." };

  const admin = createAdminClient();
  const { data: bill } = await admin
    .from("order_bills")
    .select("id, order_id, bill_number, cancelled_at")
    .eq("id", billId)
    .maybeSingle();
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.cancelled_at) return { ok: false, error: `${bill.bill_number} is already cancelled.` };

  const { count: liveNotes } = await admin
    .from("credit_notes")
    .select("id", { count: "exact", head: true })
    .eq("order_bill_id", billId)
    .eq("status", "issued");
  if ((liveNotes ?? 0) > 0) {
    return { ok: false, error: `A credit note was raised against ${bill.bill_number} — void it before cancelling the bill it reverses.` };
  }

  const { data: won, error } = await admin
    .from("order_bills")
    .update({ cancelled_at: new Date().toISOString(), cancelled_by: staff.email, cancel_reason: clean })
    .eq("id", billId)
    .is("cancelled_at", null)
    .select("id, bill_number")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!won) return { ok: false, error: "That bill was cancelled in another session." };

  // Release the lines. CAS on lines_rev, like every other writer of items.
  let linesFreed = 0;
  const { data: orderRow } = await admin
    .from("orders").select("items, lines_rev").eq("id", bill.order_id).maybeSingle();
  if (orderRow) {
    const items = ((orderRow.items ?? []) as OrderItem[]).map((it) => {
      if (it.billed_in !== billId) return it;
      linesFreed++;
      const next = { ...it };
      delete (next as { billed_in?: string | null }).billed_in;
      return next;
    });
    if (linesFreed > 0) {
      const rev = Number((orderRow as { lines_rev?: number }).lines_rev) || 0;
      const { data: patched } = await admin
        .from("orders")
        .update({ items, lines_rev: rev + 1 })
        .eq("id", bill.order_id)
        .eq("lines_rev", rev)
        .select("id")
        .maybeSingle();
      if (!patched) {
        return { ok: false, error: "The order changed while the bill was being cancelled — the bill IS cancelled, but its lines were not released. Reload and check them." };
      }
    }
  }

  await writeAuditEvent({
    eventType: "order_bill_cancelled",
    staffUserId: staff.id,
    notes: `${won.bill_number} cancelled by ${staff.email} — ${clean}; ${linesFreed} line(s) released back to the order`,
  });

  revalidatePath(`/admin/orders/${bill.order_id}`);
  revalidatePath("/admin/orders");
  return { ok: true, billNumber: won.bill_number, linesFreed };
}

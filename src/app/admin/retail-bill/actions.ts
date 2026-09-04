"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { applyMovement } from "@/lib/stock-ledger";
import { computeBillTotals, validateBillDate, billDateToIso } from "@/lib/order-lines-core";
import { renderOrderPdf } from "@/lib/order-pdf";
import { uploadOrderPdf } from "@/lib/storage";
import { DEFAULT_HSN } from "@/lib/hsn-default";
import { syncCustomToCatalog } from "@/lib/custom-catalog";
import type { DiscountType, Order, OrderItem, TaxMode } from "@/lib/types";

// Retail billing (Ansh, 31 Aug) — sell at the RETAIL price (sheet Final MRP)
// to a walk-in customer. Own RB-YYYYMMDD-NNN numbering (the number carries the
// BILL date's day, so past-dated bills file under the right day), own table,
// out of the wholesale dashboards. Stock leaves at save; voiding returns it.
// Money math reuses computeBillTotals with zero priors — same rounding and
// tax semantics as every other bill in the system.

type Res = { ok: boolean; error?: string };

export interface RetailBillInput {
  /** Catalog lines carry a sku; custom lines carry customTitle (sku optional).
   *  syncToCatalog (custom only, unchecked by default) also creates a hidden
   *  catalog product under the given sku. */
  items: { sku?: string; qty: number; unitPrice?: number; customTitle?: string; syncToCatalog?: boolean }[];
  customerName?: string;
  customerPhone?: string;
  discountType?: DiscountType;
  discountValue?: number;
  taxMode?: TaxMode;
  taxRate?: number;
  paymentMethod?: string;
  /** Past-dated billing — YYYY-MM-DD, today or earlier. Empty = today. */
  billDate?: string;
  /** Idempotency key minted by the form — a retry resolves to the same bill. */
  clientRef?: string;
}

/** Build validated OrderItems from the mixed catalog/custom line input. */
async function buildRetailItems(
  lines: RetailBillInput["items"],
): Promise<{ ok: boolean; error?: string; items?: OrderItem[] }> {
  const admin = createAdminClient();
  const skus = [...new Set(lines.filter((l) => !l.customTitle && l.sku).map((l) => l.sku!.trim().toUpperCase()))];
  const [{ data: prods }, { data: retail }] = skus.length
    ? await Promise.all([
        admin.from("wholesale_products").select("sku, title, hsn, image_urls").in("sku", skus),
        admin.from("product_vendor_info").select("sku, retail_price").in("sku", skus),
      ])
    : [{ data: [] }, { data: [] }];
  const prodBySku = new Map((prods ?? []).map((p) => [p.sku.toUpperCase(), p]));
  const retailBySku = new Map((retail ?? []).map((r) => [r.sku.toUpperCase(), Number(r.retail_price) || 0]));

  const items: OrderItem[] = [];
  for (const line of lines) {
    const qty = Math.max(1, Math.floor(Number(line.qty) || 1));
    if (qty > 999) return { ok: false, error: `Quantity ${qty} looks like a typo (max 999 per line).` };

    if (line.customTitle?.trim()) {
      // Custom line — free-typed, never validated against the catalog, holds
      // no stock. ₹0 is a legitimate freebie (same rule as wholesale).
      const unitPrice = Math.max(0, Math.round((Number(line.unitPrice) || 0) * 100) / 100);
      items.push({
        sku: (line.sku ?? "").trim().toUpperCase() || "CUSTOM",
        title: line.customTitle.trim(),
        hsn: DEFAULT_HSN,
        unit_price: unitPrice,
        qty,
        stock_state: "ready",
        restock_days: null,
        image_url: null,
        custom: true,
      });
      continue;
    }

    const sku = (line.sku ?? "").trim().toUpperCase();
    const p = prodBySku.get(sku);
    if (!p) return { ok: false, error: `${sku || "(blank)"} is not in the catalog.` };
    const listPrice = retailBySku.get(sku) ?? 0;
    const unitPrice =
      line.unitPrice != null && Number.isFinite(line.unitPrice)
        ? Math.max(0, Math.round(Number(line.unitPrice) * 100) / 100)
        : listPrice;
    if (unitPrice <= 0) return { ok: false, error: `${p.title ?? sku} has no retail price — set a ₹/pc on the line.` };
    items.push({
      sku,
      title: p.title ?? sku,
      hsn: p.hsn ?? DEFAULT_HSN,
      unit_price: unitPrice,
      qty,
      stock_state: "ready",
      restock_days: null,
      image_url: (p.image_urls as string[] | null)?.[0] ?? null,
      ...(listPrice > 0 && unitPrice !== listPrice ? { original_price: listPrice } : {}),
    });
  }
  return { ok: true, items };
}

export async function createRetailBill(
  input: RetailBillInput,
): Promise<Res & { billNumber?: string; billId?: string; pdfUrl?: string; warning?: string }> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  if (!input.items?.length) return { ok: false, error: "Add at least one item." };
  if (input.items.length > 100) return { ok: false, error: "Too many lines for one bill." };

  // Idempotency: a double-tap or a retried request resolves to the bill the
  // first attempt created — no second bill, no second stock deduction.
  const clientRef = /^[0-9a-f-]{36}$/i.test(input.clientRef ?? "") ? input.clientRef! : null;
  if (clientRef) {
    const { data: existing } = await admin
      .from("retail_bills")
      .select("id, bill_number, pdf_url")
      .eq("client_ref", clientRef)
      .maybeSingle();
    if (existing) return { ok: true, billNumber: existing.bill_number, billId: existing.id, pdfUrl: existing.pdf_url ?? undefined };
  }

  const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const billDate = input.billDate?.trim() ? validateBillDate(input.billDate, todayIst) : todayIst;
  if (!billDate) return { ok: false, error: "Bill date must be a valid date, today or earlier." };

  const built = await buildRetailItems(input.items);
  if (!built.ok) return { ok: false, error: built.error };
  const items = built.items!;

  // Catalog sync for flagged customs — BEFORE the bill, so a bad SKU aborts
  // cleanly (nothing half-created). Unchecked by default in the UI.
  for (const line of input.items) {
    if (line.customTitle && line.syncToCatalog) {
      const s = await syncCustomToCatalog({
        sku: (line.sku ?? "").trim(), title: line.customTitle, unitPrice: Number(line.unitPrice) || 0,
        kind: "retail", createdBy: staff.email,
      });
      if (!s.ok) return { ok: false, error: s.error };
    }
  }

  const discountType: DiscountType | null =
    input.discountType === "percent" || input.discountType === "absolute" ? input.discountType : null;
  const discountValue = discountType
    ? discountType === "percent"
      ? Math.min(100, Math.max(0, Number(input.discountValue) || 0))
      : Math.max(0, Number(input.discountValue) || 0)
    : null;
  const taxMode: TaxMode = input.taxMode === "inclusive" || input.taxMode === "exclusive" ? input.taxMode : "none";
  const taxRate = taxMode === "none" ? null : Math.min(28, Math.max(0, Number(input.taxRate) || 0));

  const totals = computeBillTotals(
    items,
    { discount_type: discountType, discount_value: discountValue, tax_mode: taxMode, tax_rate: taxRate, advance_amount: 0 },
    { discountApplied: 0, advanceApplied: 0 },
  );

  // RB numbering — atomic counter, day taken from the BILL date.
  const ymd = billDate.replace(/-/g, "");
  let bill: { id: string; bill_number: string } | null = null;
  for (let attempt = 1; attempt <= 3 && !bill; attempt++) {
    const { data: numData, error: numErr } = await admin.rpc("next_order_number", { p_prefix: "RB", p_day: ymd });
    if (numErr || !numData) return { ok: false, error: numErr?.message ?? "Could not generate a bill number." };
    const { data, error } = await admin
      .from("retail_bills")
      .insert({
        bill_number: numData as string,
        customer_name: input.customerName?.trim().slice(0, 120) || null,
        customer_phone: input.customerPhone?.trim().slice(0, 20) || null,
        items,
        subtotal: totals.subtotal,
        discount_type: discountType,
        discount_value: discountValue,
        discount_amount: totals.discountAmount,
        tax_mode: totals.taxMode,
        tax_rate: totals.taxRate,
        tax_amount: totals.taxAmount,
        total: totals.total,
        payment_method: input.paymentMethod?.trim() || null,
        bill_date: billDate,
        client_ref: clientRef,
        created_by: staff.email,
      })
      .select("id, bill_number")
      .single();
    if (data) bill = data;
    else if (error && error.code === "23505" && clientRef) {
      // The retry's twin already inserted under our client_ref — return it.
      const { data: won } = await admin.from("retail_bills").select("id, bill_number, pdf_url").eq("client_ref", clientRef).maybeSingle();
      if (won) return { ok: true, billNumber: won.bill_number, billId: won.id, pdfUrl: won.pdf_url ?? undefined };
    } else if (error && error.code !== "23505") return { ok: false, error: error.message };
  }
  if (!bill) return { ok: false, error: "Could not reserve a bill number — retry." };

  // Stock leaves the shelf now — one movement per line. A failed movement
  // must never hide (review fix, 31 Aug): the bill stands (the sale
  // physically happened), but staff are told exactly which SKUs to adjust.
  const moveFailed: string[] = [];
  for (const it of items) {
    if (it.custom) continue; // custom lines hold no stock
    const res = await applyMovement({
      sku: it.sku, delta: -it.qty, reason: "order", refType: "retail_bill", refId: bill.id,
      note: `Retail bill ${bill.bill_number} — sold`, createdBy: staff.email,
    });
    if (!res.ok) moveFailed.push(it.sku);
  }

  // PDF — best-effort; the bill row already stands.
  let pdfUrl: string | undefined;
  try {
    const synthetic = {
      order_number: bill.bill_number,
      source: "in_store",
      items,
      total_amount: totals.total,
      discount_type: discountType,
      discount_value: discountValue,
      discount_amount: totals.discountAmount,
      tax_mode: totals.taxMode,
      tax_rate: totals.taxRate,
      tax_amount: totals.taxAmount,
      advance_amount: 0,
      payment_method: input.paymentMethod?.trim() || null,
      notes: null,
      submitted_at: billDateToIso(billDate),
    } as unknown as Order;
    const pdf = await renderOrderPdf(
      synthetic,
      { business_name: input.customerName?.trim() || "Retail Customer", owner_name: null, phone: input.customerPhone?.trim() || null, city: null },
      undefined,
      { tagline: "RETAIL - INVOICE", metaLine: "Retail sale" },
    );
    pdfUrl = await uploadOrderPdf(bill.id, bill.bill_number, pdf);
    await admin.from("retail_bills").update({ pdf_url: pdfUrl }).eq("id", bill.id);
  } catch (e) {
    console.error("retail bill PDF failed (bill stands):", (e as Error).message);
  }

  revalidatePath("/admin/retail-bill");
  return {
    ok: true,
    billNumber: bill.bill_number,
    billId: bill.id,
    pdfUrl,
    ...(moveFailed.length > 0
      ? { warning: `Bill saved, but stock did NOT post for ${moveFailed.join(", ")} — adjust in Stock take.` }
      : {}),
  };
}

/** Void a bill: stock comes back, the row stays as a flagged record. */
export async function voidRetailBill(billId: string): Promise<Res> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: bill } = await admin.from("retail_bills").select("id, bill_number, items, voided_at").eq("id", billId).maybeSingle();
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.voided_at) return { ok: false, error: "Already voided." };

  // CAS on voided_at so a double-tap can't return stock twice.
  const { data: won, error } = await admin
    .from("retail_bills")
    .update({ voided_at: new Date().toISOString(), voided_by: staff.email })
    .eq("id", billId)
    .is("voided_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!won) return { ok: false, error: "Already voided." };

  const returnFailed: string[] = [];
  for (const it of (bill.items ?? []) as OrderItem[]) {
    const res = await applyMovement({
      sku: it.sku, delta: Math.trunc(Number(it.qty) || 0), reason: "correction", refType: "retail_bill", refId: billId,
      note: `Retail bill ${bill.bill_number} — voided, stock returned`, createdBy: staff.email,
    });
    if (!res.ok) returnFailed.push(it.sku);
  }
  revalidatePath("/admin/retail-bill");
  if (returnFailed.length > 0) {
    // The void stands (CAS won) — but staff must know the ledger is short.
    return { ok: true, error: `Voided, but stock did NOT return for ${returnFailed.join(", ")} — adjust in Stock take.` };
  }
  return { ok: true };
}

/**
 * Modify a saved retail bill (Ansh, 4 Sep — parity with Modify Order). The
 * form sends the COMPLETE new line list + terms; money is recomputed
 * server-side and stock follows the edit: per catalog SKU, only the DELTA
 * between old and new quantities moves. The bill keeps its number and date;
 * the PDF regenerates in place. Voided bills are history — not editable.
 */
export async function updateRetailBill(
  billId: string,
  input: Omit<RetailBillInput, "billDate" | "clientRef">,
): Promise<Res & { warning?: string }> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  const { data: bill } = await admin.from("retail_bills").select("*").eq("id", billId).maybeSingle();
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.voided_at) return { ok: false, error: "This bill is voided — create a new one instead." };
  if (!input.items?.length) return { ok: false, error: "A bill needs at least one line — use Void instead." };
  if (input.items.length > 100) return { ok: false, error: "Too many lines for one bill." };

  const built = await buildRetailItems(input.items);
  if (!built.ok) return { ok: false, error: built.error };
  const items = built.items!;

  for (const line of input.items) {
    if (line.customTitle && line.syncToCatalog) {
      const s = await syncCustomToCatalog({
        sku: (line.sku ?? "").trim(), title: line.customTitle, unitPrice: Number(line.unitPrice) || 0,
        kind: "retail", createdBy: staff.email,
      });
      if (!s.ok) return { ok: false, error: s.error };
    }
  }

  const discountType: DiscountType | null =
    input.discountType === "percent" || input.discountType === "absolute" ? input.discountType : null;
  const discountValue = discountType
    ? discountType === "percent"
      ? Math.min(100, Math.max(0, Number(input.discountValue) || 0))
      : Math.max(0, Number(input.discountValue) || 0)
    : null;
  const taxMode: TaxMode = input.taxMode === "inclusive" || input.taxMode === "exclusive" ? input.taxMode : "none";
  const taxRate = taxMode === "none" ? null : Math.min(28, Math.max(0, Number(input.taxRate) || 0));
  const totals = computeBillTotals(
    items,
    { discount_type: discountType, discount_value: discountValue, tax_mode: taxMode, tax_rate: taxRate, advance_amount: 0 },
    { discountApplied: 0, advanceApplied: 0 },
  );

  // Stock deltas per catalog SKU — write the row FIRST (so a movement failure
  // never desyncs the printed bill), then post the deltas and surface misses.
  const agg = (list: OrderItem[]) => {
    const m = new Map<string, number>();
    for (const it of list) if (!it.custom && it.sku) m.set(it.sku, (m.get(it.sku) ?? 0) + Math.trunc(Number(it.qty) || 0));
    return m;
  };
  const before = agg((bill.items ?? []) as OrderItem[]);
  const after = agg(items);
  const deltas: { sku: string; delta: number }[] = [];
  for (const [sku, q] of after) { const d = q - (before.get(sku) ?? 0); if (d !== 0) deltas.push({ sku, delta: d }); }
  for (const [sku, q] of before) if (!after.has(sku)) deltas.push({ sku, delta: -q });

  const { data: won, error } = await admin
    .from("retail_bills")
    .update({
      customer_name: input.customerName?.trim().slice(0, 120) || null,
      customer_phone: input.customerPhone?.trim().slice(0, 20) || null,
      items,
      subtotal: totals.subtotal,
      discount_type: discountType,
      discount_value: discountValue,
      discount_amount: totals.discountAmount,
      tax_mode: totals.taxMode,
      tax_rate: totals.taxRate,
      tax_amount: totals.taxAmount,
      total: totals.total,
      payment_method: input.paymentMethod?.trim() || null,
    })
    .eq("id", billId)
    .is("voided_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!won) return { ok: false, error: "The bill was voided under you — reload." };

  const moveFailed: string[] = [];
  for (const d of deltas) {
    const res = await applyMovement({
      sku: d.sku,
      delta: -d.delta, // more pieces billed → stock out; fewer → back
      reason: d.delta > 0 ? "order" : "correction",
      refType: "retail_bill", refId: billId,
      note: `Retail bill ${bill.bill_number} — edited (${d.delta > 0 ? "+" : ""}${d.delta} pc)`,
      createdBy: staff.email,
    });
    if (!res.ok) moveFailed.push(d.sku);
  }

  // Regenerate the stored PDF in place (the permanent route regenerates
  // live anyway — this keeps the cached copy fresh too).
  try {
    const synthetic = {
      order_number: bill.bill_number,
      source: "in_store",
      items,
      total_amount: totals.total,
      discount_type: discountType,
      discount_value: discountValue,
      discount_amount: totals.discountAmount,
      tax_mode: totals.taxMode,
      tax_rate: totals.taxRate,
      tax_amount: totals.taxAmount,
      advance_amount: 0,
      payment_method: input.paymentMethod?.trim() || null,
      notes: null,
      submitted_at: billDateToIso(bill.bill_date),
    } as unknown as Order;
    const pdf = await renderOrderPdf(
      synthetic,
      { business_name: input.customerName?.trim() || "Retail Customer", owner_name: null, phone: input.customerPhone?.trim() || null, city: null },
      undefined,
      { tagline: "RETAIL - INVOICE", metaLine: "Retail sale (amended)" },
    );
    const pdfUrl = await uploadOrderPdf(billId, bill.bill_number, pdf);
    await admin.from("retail_bills").update({ pdf_url: pdfUrl }).eq("id", billId);
  } catch (e) {
    console.error("retail bill PDF regen failed (bill stands):", (e as Error).message);
  }

  revalidatePath("/admin/retail-bill");
  revalidatePath("/admin/orders");
  return {
    ok: true,
    ...(moveFailed.length > 0
      ? { warning: `Updated, but stock did NOT adjust for ${moveFailed.join(", ")} — fix in Stock take.` }
      : {}),
  };
}

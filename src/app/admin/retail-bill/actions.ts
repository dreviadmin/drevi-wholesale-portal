"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { applyMovement } from "@/lib/stock-ledger";
import { computeBillTotals, validateBillDate, billDateToIso } from "@/lib/order-lines-core";
import { renderOrderPdf } from "@/lib/order-pdf";
import { uploadOrderPdf } from "@/lib/storage";
import { DEFAULT_HSN } from "@/lib/hsn-default";
import type { DiscountType, Order, OrderItem, TaxMode } from "@/lib/types";

// Retail billing (Ansh, 31 Aug) — sell at the RETAIL price (sheet Final MRP)
// to a walk-in customer. Own RB-YYYYMMDD-NNN numbering (the number carries the
// BILL date's day, so past-dated bills file under the right day), own table,
// out of the wholesale dashboards. Stock leaves at save; voiding returns it.
// Money math reuses computeBillTotals with zero priors — same rounding and
// tax semantics as every other bill in the system.

type Res = { ok: boolean; error?: string };

export interface RetailBillInput {
  items: { sku: string; qty: number; unitPrice?: number }[];
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

  // Server-side pricing: the retail price is the floor of trust — a client
  // price only overrides it when explicitly set (staff negotiation).
  const skus = [...new Set(input.items.map((i) => i.sku.trim().toUpperCase()))];
  const [{ data: prods }, { data: retail }] = await Promise.all([
    admin.from("wholesale_products").select("sku, title, hsn, image_urls").in("sku", skus),
    admin.from("product_vendor_info").select("sku, retail_price").in("sku", skus),
  ]);
  const prodBySku = new Map((prods ?? []).map((p) => [p.sku.toUpperCase(), p]));
  const retailBySku = new Map((retail ?? []).map((r) => [r.sku.toUpperCase(), Number(r.retail_price) || 0]));

  const items: OrderItem[] = [];
  for (const line of input.items) {
    const sku = line.sku.trim().toUpperCase();
    const p = prodBySku.get(sku);
    if (!p) return { ok: false, error: `${sku} is not in the catalog.` };
    const qty = Math.max(1, Math.floor(Number(line.qty) || 1));
    if (qty > 999) return { ok: false, error: `${sku}: quantity ${qty} looks like a typo (max 999 per line).` };
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

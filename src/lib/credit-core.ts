import type { OrderItem, TaxMode } from "@/lib/types";

// Pure rules for credit notes, returns and party wallets (11 Sep). No
// server-only imports, no supabase — everything here is unit-tested, the same
// way order-lines-core.ts carries the billing rules.

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A line as it was frozen into order_bills.items, plus where it sits there. */
export interface BillLine {
  item: OrderItem;
  index: number;
}

/** The money terms of the bill being returned against. */
export interface SourceBill {
  subtotal: number;
  discount_amount: number;
  tax_mode: string | null;
  tax_rate: number | null;
}

export interface ReturnRequestLine {
  billLineIndex: number;
  qty: number;
  restock: boolean;
}

export interface CreditLineSnapshot {
  sku: string;
  title: string | null;
  hsn: string | null;
  qty: number;
  unit_price: number;
  line_amount: number;
  discount_share: number;
  net_amount: number;
  bill_line_index: number;
  order_line_index: number | null;
  restock: boolean;
  image_url: string | null;
}

export interface CreditTotals {
  items: CreditLineSnapshot[];
  sourceSubtotal: number;
  discountShare: number;
  subtotal: number;
  taxMode: TaxMode;
  taxRate: number | null;
  taxAmount: number;
  total: number;
}

/**
 * What a returned line is actually worth.
 *
 * The buyer paid the bill's NET, not its gross: computeBillTotals subtracts the
 * discount before tax, and for an absolute ₹ discount the share borne by each
 * bill differs (it is a pot consumed across bills). So the credit for a line is
 * its slice of THIS bill's discount, taken pro-rata by line amount. Crediting
 * the raw unit price would hand back money that was never collected.
 */
export function discountShareFor(bill: Pick<SourceBill, "subtotal" | "discount_amount">, lineAmount: number): number {
  const subtotal = Number(bill.subtotal) || 0;
  const discount = Number(bill.discount_amount) || 0;
  if (subtotal <= 0 || discount <= 0) return 0;
  return r2(lineAmount * (discount / subtotal));
}

/**
 * Credit totals for a set of returned quantities, using the bill's own terms.
 * The tax branch mirrors computeBillTotals exactly so that returning every line
 * of a bill credits precisely that bill's total (pinned by a test).
 */
export function computeCreditTotals(
  lines: { line: BillLine; qty: number; restock: boolean; orderLineIndex: number | null }[],
  bill: SourceBill,
): CreditTotals {
  const items: CreditLineSnapshot[] = lines.map(({ line, qty, restock, orderLineIndex }) => {
    const unit = Number(line.item.unit_price) || 0;
    const lineAmount = r2(qty * unit);
    const share = discountShareFor(bill, lineAmount);
    return {
      sku: line.item.sku,
      title: line.item.title ?? null,
      hsn: line.item.hsn ?? null,
      qty,
      unit_price: unit,
      line_amount: lineAmount,
      discount_share: share,
      net_amount: r2(lineAmount - share),
      bill_line_index: line.index,
      order_line_index: orderLineIndex,
      restock,
      image_url: line.item.image_url ?? null,
    };
  });

  const sourceSubtotal = r2(items.reduce((s, i) => s + i.line_amount, 0));
  const discountShare = r2(items.reduce((s, i) => s + i.discount_share, 0));
  const subtotal = r2(sourceSubtotal - discountShare);

  const taxMode: TaxMode = bill.tax_mode === "inclusive" || bill.tax_mode === "exclusive" ? bill.tax_mode : "none";
  let taxRate: number | null = null;
  let taxAmount = 0;
  let total = subtotal;
  if (taxMode !== "none") {
    taxRate = Number(bill.tax_rate) || 0;
    if (taxMode === "exclusive") {
      taxAmount = r2(subtotal * (taxRate / 100));
      total = r2(subtotal + taxAmount);
    } else {
      taxAmount = r2(subtotal * (taxRate / (100 + taxRate)));
      total = subtotal;
    }
  }

  return { items, sourceSubtotal, discountShare, subtotal, taxMode, taxRate, taxAmount, total };
}

/** A credit note as far as the return-cap arithmetic is concerned. */
export interface CreditNoteLike {
  id: string;
  status: string;
  order_bill_id: string | null;
  items: { bill_line_index?: number | null; qty?: number | null; sku?: string | null }[] | null;
}

/**
 * How much of each BILL line has already come back, keyed `<billId>:<index>`.
 * The bill snapshot is the anchor because order_bills.items is immutable —
 * a position in orders.items is not (Modify Order re-packs that array).
 */
export function returnedByBillLine(notes: CreditNoteLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of notes) {
    if (n.status !== "issued" || !n.order_bill_id) continue;
    for (const it of n.items ?? []) {
      if (it?.bill_line_index == null) continue;
      const key = `${n.order_bill_id}:${it.bill_line_index}`;
      out.set(key, r2((out.get(key) ?? 0) + (Number(it.qty) || 0)));
    }
  }
  return out;
}

export function remainingReturnable(billedQty: number, alreadyReturned: number): number {
  return Math.max(0, (Number(billedQty) || 0) - (Number(alreadyReturned) || 0));
}

/** A grant (an issued credit note) for wallet arithmetic. */
export interface WalletGrant {
  id: string;
  total: number;
  status: string;
  effective_date: string;
  created_at: string;
}

/** A consumption row from credit_ledger (delta is negative when credit is spent). */
export interface WalletEntry {
  id: string;
  delta: number;
  reason: string;
  effective_date: string;
  created_at: string;
}

/**
 * Wallet balance = what was granted by issued notes, less net consumption.
 * The notes ARE the grants, so a note can never exist without its credit.
 * Numerics can arrive from PostgREST as strings — coerce at the boundary or Σ
 * over strings concatenates.
 */
export function walletBalance(grants: WalletGrant[], entries: WalletEntry[]): number {
  const granted = grants.reduce((s, g) => (g.status === "issued" ? s + (Number(g.total) || 0) : s), 0);
  const net = entries.reduce((s, e) => s + (Number(e.delta) || 0), 0);
  return r2(granted + net);
}

export interface NoteAllocation {
  consumed: number;
  remaining: number;
}

/**
 * "How much of THIS credit note is left" — consumption is drawn from the
 * oldest open note first (FIFO by effective date, then created_at, then id),
 * which is also the order a person reading the ledger would assume.
 */
export function allocateConsumption(grants: WalletGrant[], entries: WalletEntry[]): Map<string, NoteAllocation> {
  const order = (a: { effective_date: string; created_at: string; id: string }, b: typeof a) =>
    a.effective_date.localeCompare(b.effective_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

  const open = grants.filter((g) => g.status === "issued").slice().sort(order);
  const alloc = new Map<string, NoteAllocation>();
  for (const g of open) alloc.set(g.id, { consumed: 0, remaining: r2(Number(g.total) || 0) });

  // Net consumption: spends less their reversals, applied oldest-note-first.
  let toDraw = r2(-entries.reduce((s, e) => s + (Number(e.delta) || 0), 0));
  if (toDraw <= 0) return alloc;

  for (const g of open) {
    if (toDraw <= 0) break;
    const a = alloc.get(g.id)!;
    const take = Math.min(a.remaining, toDraw);
    a.consumed = r2(a.consumed + take);
    a.remaining = r2(a.remaining - take);
    toDraw = r2(toDraw - take);
  }
  return alloc;
}

/** A manual credit amount: a positive number with at most two decimals. */
export function validateCreditAmount(raw: unknown, max?: number): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Enter an amount above ₹0" };
  const value = r2(n);
  if (max != null && value > r2(max)) return { ok: false, error: `Only ${r2(max)} is available` };
  return { ok: true, value };
}

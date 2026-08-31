import type { Order, OrderItem, OrderStatus, TaxMode } from "@/lib/types";

// Line-level confirmation + split billing (Ansh, 18 Aug) — the pure rules,
// kept import-safe for vitest (no server-only, no supabase).
//
// A line's EFFECTIVE state: an explicit line_state always wins; a legacy line
// (no line_state) follows the order — confirmed once the order is past
// submitted, pending before that. Billing "consumes" confirmed lines: each
// bill snapshots the confirmed-and-unbilled set, so one order can produce
// several bills as held items become available.

export type LineState = "confirmed" | "hold" | "pending" | "billed";

const POST_SUBMIT: OrderStatus[] = ["confirmed", "packed", "out_for_delivery", "delivered", "fulfilled"];

export function effectiveLineState(item: OrderItem, orderStatus: OrderStatus): LineState {
  if (item.billed_in) return "billed";
  if (item.line_state === "confirmed") return "confirmed";
  if (item.line_state === "hold") return "hold";
  if (item.line_state === "pending") return "pending"; // explicit un-confirm survives a confirmed order
  if (POST_SUBMIT.includes(orderStatus)) return "confirmed"; // legacy whole-order flow
  return "pending";
}

/** Confirmed-and-unbilled lines — what the next bill would contain. */
export function billableLines(order: Pick<Order, "items" | "status">): { item: OrderItem; index: number }[] {
  return (order.items ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => effectiveLineState(item, order.status) === "confirmed");
}

/** Lines still owed to the customer (on hold, or simply not confirmed yet). */
export function pendingLines(order: Pick<Order, "items" | "status">): { item: OrderItem; index: number; state: "hold" | "pending" }[] {
  return (order.items ?? [])
    .map((item, index) => ({ item, index, state: effectiveLineState(item, order.status) }))
    .filter((x): x is { item: OrderItem; index: number; state: "hold" | "pending" } => x.state === "hold" || x.state === "pending");
}

export interface BillTotals {
  subtotal: number;
  discountAmount: number;
  taxMode: TaxMode;
  taxRate: number | null;
  taxAmount: number;
  total: number;
  advanceApplied: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** What earlier bills of the order have already consumed. */
export interface PriorBills {
  /** Sum of discount_amount on earlier bills (relevant for absolute discounts). */
  discountApplied: number;
  /** Sum of advance_applied on earlier bills. */
  advanceApplied: number;
}

/**
 * Totals for one bill, derived from the ORDER's billing terms:
 *   · a percent discount applies to every bill (it scales with the lines);
 *   · an absolute ₹ discount is a fixed pot — each bill consumes what earlier
 *     bills left, capped at its own subtotal, until the pot is empty;
 *   · tax follows the order's mode/rate;
 *   · the order's advance is a fixed pot too — shown against bills in order
 *     until exhausted (review fix, 18 Aug: an advance larger than the first
 *     bill used to lose its remainder).
 */
export function computeBillTotals(
  lines: OrderItem[],
  order: Pick<Order, "discount_type" | "discount_value" | "tax_mode" | "tax_rate" | "advance_amount">,
  prior: PriorBills,
): BillTotals {
  const subtotal = r2(lines.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0));

  let discountAmount = 0;
  if (order.discount_type === "percent" && order.discount_value) {
    discountAmount = r2(subtotal * (Number(order.discount_value) / 100));
  } else if (order.discount_type === "absolute" && order.discount_value) {
    const remaining = Math.max(0, r2(Number(order.discount_value) - (Number(prior.discountApplied) || 0)));
    discountAmount = Math.min(subtotal, remaining);
  }
  const net = r2(subtotal - discountAmount);

  const taxMode: TaxMode = order.tax_mode === "inclusive" || order.tax_mode === "exclusive" ? order.tax_mode : "none";
  let taxRate: number | null = null;
  let taxAmount = 0;
  let total = net;
  if (taxMode !== "none") {
    taxRate = Number(order.tax_rate) || 0;
    if (taxMode === "exclusive") {
      taxAmount = r2(net * (taxRate / 100));
      total = r2(net + taxAmount);
    } else {
      taxAmount = r2(net * (taxRate / (100 + taxRate)));
      total = net;
    }
  }

  const advanceRemaining = Math.max(0, r2((Number(order.advance_amount) || 0) - (Number(prior.advanceApplied) || 0)));
  const advanceApplied = Math.min(total, advanceRemaining);
  return { subtotal, discountAmount, taxMode, taxRate, taxAmount, total, advanceApplied };
}

/**
 * Validate a user-chosen bill date (past-dated billing, Ansh 18 Aug).
 * Accepts YYYY-MM-DD; must not be in the future (IST) nor absurdly old.
 * Returns the normalised date string, or null when invalid.
 */
export function validateBillDate(raw: string | undefined | null, todayIst?: string): string | null {
  if (!raw?.trim()) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const today = todayIst ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  if (iso > today) return null;      // no future-dating
  if (iso < "2025-01-01") return null; // sanity floor
  return iso;
}

/** ISO timestamp for a bill date — noon IST so IST day-bucketing can't drift. */
export function billDateToIso(ymd: string): string {
  return `${ymd}T12:00:00+05:30`;
}

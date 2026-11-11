import { describe, it, expect } from "vitest";
import { effectiveLineState, billableLines, pendingLines, computeBillTotals, priorBillsConsumed, billingTermsChanged, validateBillDate, billDateToIso, emptyBillReason, addedLineTakesStock } from "./order-lines-core";
import type { OrderItem, OrderStatus } from "./types";

const line = (over: Partial<OrderItem> = {}): OrderItem => ({
  sku: "DD-TST-001-M-BLK",
  title: "Test",
  unit_price: 1000,
  qty: 2,
  stock_state: "ready",
  restock_days: null,
  ...over,
});

describe("effectiveLineState", () => {
  it("billed wins over everything", () => {
    expect(effectiveLineState(line({ billed_in: "b1", line_state: "hold" }), "submitted")).toBe("billed");
  });
  it("explicit states win over the order status", () => {
    expect(effectiveLineState(line({ line_state: "hold" }), "confirmed")).toBe("hold");
    expect(effectiveLineState(line({ line_state: "confirmed" }), "submitted")).toBe("confirmed");
  });
  it("legacy lines follow the order", () => {
    expect(effectiveLineState(line(), "submitted")).toBe("pending");
    expect(effectiveLineState(line(), "confirmed")).toBe("confirmed");
    expect(effectiveLineState(line(), "delivered")).toBe("confirmed");
    expect(effectiveLineState(line(), "cancelled")).toBe("pending");
  });
});

describe("addedLineTakesStock — a line added by Modify Order leaves the shelf when it reads confirmed", () => {
  const ALL: OrderStatus[] = ["submitted", "confirmed", "packed", "out_for_delivery", "delivered", "fulfilled", "cancelled"];
  it("moves stock on every post-submit order, including delivered and fulfilled", () => {
    for (const s of ["confirmed", "packed", "out_for_delivery", "delivered", "fulfilled"] as OrderStatus[]) {
      expect(addedLineTakesStock(s)).toBe(true);
    }
  });
  it("leaves a submitted order's add for the whole-order confirm to move", () => {
    expect(addedLineTakesStock("submitted")).toBe(false);
  });
  it("agrees with effectiveLineState for a fresh added line (no line_state) on every status", () => {
    for (const s of ALL) {
      expect(addedLineTakesStock(s)).toBe(effectiveLineState(line(), s) === "confirmed");
    }
  });
});

describe("emptyBillReason — the message when there is nothing to bill", () => {
  const L = (x: Partial<OrderItem>): OrderItem => ({ sku: "DD-A-B-001-M-RED", title: "x", unit_price: 100, qty: 1, stock_state: "ready", restock_days: null, image_url: null, ...x } as OrderItem);
  it("every line already billed → points at the bill, never at confirmation (IS-20260930-001)", () => {
    expect(emptyBillReason({ status: "packed", items: [L({ billed_in: "b1" }), L({ billed_in: "b1" })] })).toEqual({ kind: "already_billed", billed: 2 });
  });
  it("pending and held lines are counted", () => {
    expect(emptyBillReason({ status: "submitted", items: [L({}), L({ line_state: "hold" }), L({ billed_in: "b1" })] })).toEqual({ kind: "nothing_ready", pending: 1, held: 1, billed: 1 });
  });
  it("an empty order is nothing_ready with zero counts", () => {
    expect(emptyBillReason({ status: "confirmed", items: [] })).toEqual({ kind: "nothing_ready", pending: 0, held: 0, billed: 0 });
  });
});

describe("billableLines / pendingLines", () => {
  const order = {
    status: "submitted" as const,
    items: [
      line({ sku: "A", line_state: "confirmed" }),
      line({ sku: "B", line_state: "hold", hold_note: "2 weeks" }),
      line({ sku: "C" }),
      line({ sku: "D", line_state: "confirmed", billed_in: "bill-1" }),
    ],
  };
  it("bills only confirmed-and-unbilled", () => {
    expect(billableLines(order).map((x) => x.item.sku)).toEqual(["A"]);
  });
  it("pending = hold + untouched, never billed", () => {
    expect(pendingLines(order).map((x) => [x.item.sku, x.state])).toEqual([
      ["B", "hold"],
      ["C", "pending"],
    ]);
  });
  it("a confirmed order has no pending legacy lines", () => {
    expect(pendingLines({ status: "confirmed", items: [line()] })).toEqual([]);
  });
});

describe("computeBillTotals", () => {
  const items = [line({ qty: 2, unit_price: 1000 }), line({ sku: "X", qty: 1, unit_price: 500 })]; // 2500
  const none = { discountApplied: 0, advanceApplied: 0 };

  it("plain bill", () => {
    const t = computeBillTotals(items, { discount_type: null, discount_value: null, tax_mode: "none", tax_rate: null, advance_amount: 0 }, none);
    expect(t).toMatchObject({ subtotal: 2500, discountAmount: 0, taxAmount: 0, total: 2500, advanceApplied: 0 });
  });
  it("percent discount applies to every bill", () => {
    const o = { discount_type: "percent" as const, discount_value: 10, tax_mode: "none" as const, tax_rate: null, advance_amount: 0 };
    expect(computeBillTotals(items, o, none).total).toBe(2250);
    expect(computeBillTotals(items, o, { discountApplied: 250, advanceApplied: 0 }).total).toBe(2250);
  });
  it("absolute discount is a pot: capped per bill, remainder carries", () => {
    const o = { discount_type: "absolute" as const, discount_value: 3000, tax_mode: "none" as const, tax_rate: null, advance_amount: 0 };
    // first bill consumes 2500 of the 3000 pot
    expect(computeBillTotals(items, o, none)).toMatchObject({ discountAmount: 2500, total: 0 });
    // second bill gets the remaining 500
    expect(computeBillTotals(items, o, { discountApplied: 2500, advanceApplied: 0 })).toMatchObject({ discountAmount: 500, total: 2000 });
    // pot exhausted
    expect(computeBillTotals(items, o, { discountApplied: 3000, advanceApplied: 0 })).toMatchObject({ discountAmount: 0, total: 2500 });
  });
  it("exclusive tax adds on top; inclusive extracts", () => {
    const ex = computeBillTotals(items, { discount_type: null, discount_value: null, tax_mode: "exclusive", tax_rate: 5, advance_amount: 0 }, none);
    expect(ex).toMatchObject({ taxAmount: 125, total: 2625 });
    const inc = computeBillTotals(items, { discount_type: null, discount_value: null, tax_mode: "inclusive", tax_rate: 5, advance_amount: 0 }, none);
    expect(inc.total).toBe(2500);
    expect(inc.taxAmount).toBeCloseTo(119.05, 2);
  });
  it("advance is a pot: capped per bill, remainder carries to later bills", () => {
    const o = { discount_type: null, discount_value: null, tax_mode: "none" as const, tax_rate: null, advance_amount: 4000 };
    expect(computeBillTotals(items, o, none).advanceApplied).toBe(2500);
    expect(computeBillTotals(items, o, { discountApplied: 0, advanceApplied: 2500 }).advanceApplied).toBe(1500);
    expect(computeBillTotals(items, o, { discountApplied: 0, advanceApplied: 4000 }).advanceApplied).toBe(0);
  });
});

describe("priorBillsConsumed — a cancelled bill gives its share of the pots back", () => {
  it("sums only live bills", () => {
    expect(
      priorBillsConsumed([
        { discount_amount: 500, advance_applied: 1000, cancelled_at: null },
        { discount_amount: 2000, advance_applied: 5000, cancelled_at: "2026-10-01T10:00:00Z" },
        { discount_amount: 250, advance_applied: 0 },
      ]),
    ).toEqual({ discountApplied: 750, advanceApplied: 1000 });
  });
  it("no bills, or only cancelled ones, consume nothing", () => {
    expect(priorBillsConsumed([])).toEqual({ discountApplied: 0, advanceApplied: 0 });
    expect(priorBillsConsumed([{ discount_amount: 2000, advance_applied: 5000, cancelled_at: "2026-10-01T10:00:00Z" }])).toEqual({ discountApplied: 0, advanceApplied: 0 });
  });
  it("a bill re-raised after cancelling B1 gets the discount and advance B1 had", () => {
    // ₹20,000 of lines, ₹2,000 absolute discount, ₹5,000 advance; B1 took it all, then was cancelled.
    const lines = [line({ qty: 10, unit_price: 2000 })];
    const o = { discount_type: "absolute" as const, discount_value: 2000, tax_mode: "none" as const, tax_rate: null, advance_amount: 5000 };
    const b1 = computeBillTotals(lines, o, priorBillsConsumed([]));
    const b2 = computeBillTotals(lines, o, priorBillsConsumed([{ discount_amount: b1.discountAmount, advance_applied: b1.advanceApplied, cancelled_at: "2026-10-02T09:00:00Z" }]));
    expect(b2).toMatchObject({ discountAmount: 2000, total: 18000, advanceApplied: 5000 });
    expect(b2).toEqual(b1);
  });
});

describe("billingTermsChanged — Modify Order's freeze refuses a MOVE, not a save", () => {
  const stored = { discount_type: "absolute" as const, discount_value: 2000, tax_mode: "exclusive" as const, tax_rate: 12 };
  const same = { discountType: "absolute" as const, discountValue: 2000, taxMode: "exclusive" as const, taxRate: 12 };
  it("the editor re-sending the stored terms is not a change (a pending-line edit on a billed order)", () => {
    expect(billingTermsChanged(stored, same)).toBe(false);
  });
  it("every real move is a change", () => {
    expect(billingTermsChanged(stored, { ...same, discountValue: 2500 })).toBe(true);
    expect(billingTermsChanged(stored, { ...same, discountType: "percent" })).toBe(true);
    expect(billingTermsChanged(stored, { ...same, discountType: null, discountValue: null })).toBe(true);
    expect(billingTermsChanged(stored, { ...same, taxMode: "inclusive" })).toBe(true);
    expect(billingTermsChanged(stored, { ...same, taxMode: "none", taxRate: null })).toBe(true);
    expect(billingTermsChanged(stored, { ...same, taxRate: 18 })).toBe(true);
  });
  it("adding terms to an order that had none is a change", () => {
    const bare = { discount_type: null, discount_value: null, tax_mode: "none" as const, tax_rate: null };
    expect(billingTermsChanged(bare, { discountType: null, discountValue: null, taxMode: "none", taxRate: null })).toBe(false);
    expect(billingTermsChanged(bare, { discountType: "percent", discountValue: 10, taxMode: "none", taxRate: null })).toBe(true);
    expect(billingTermsChanged(bare, { discountType: null, discountValue: null, taxMode: "exclusive", taxRate: 5 })).toBe(true);
  });
  it("what no bill prices off is ignored: a value with no type, a rate with no tax, null vs 0", () => {
    expect(billingTermsChanged({ discount_type: null, discount_value: 300, tax_mode: "none", tax_rate: 12 }, { discountType: null, discountValue: null, taxMode: "none", taxRate: null })).toBe(false);
    expect(billingTermsChanged({ discount_type: "percent", discount_value: null, tax_mode: "none", tax_rate: null }, { discountType: "percent", discountValue: 0, taxMode: "none", taxRate: null })).toBe(false);
  });
  it("a stored figure the save would only normalise still counts — later bills would see it", () => {
    // Legacy exclusive order with no rate: bills priced it at 0%, the save would store 5%.
    expect(billingTermsChanged({ discount_type: null, discount_value: null, tax_mode: "exclusive", tax_rate: null }, { discountType: null, discountValue: null, taxMode: "exclusive", taxRate: 5 })).toBe(true);
    // An unclamped 150% the save would clamp to 100%.
    expect(billingTermsChanged({ discount_type: "percent", discount_value: 150, tax_mode: "none", tax_rate: null }, { discountType: "percent", discountValue: 100, taxMode: "none", taxRate: null })).toBe(true);
  });
});

describe("validateBillDate", () => {
  const today = "2026-08-18";
  it("accepts today and the past", () => {
    expect(validateBillDate("2026-08-18", today)).toBe("2026-08-18");
    expect(validateBillDate("2026-08-01", today)).toBe("2026-08-01");
  });
  it("rejects the future, garbage and impossible dates", () => {
    expect(validateBillDate("2026-08-19", today)).toBeNull();
    expect(validateBillDate("2026-02-30", today)).toBeNull();
    expect(validateBillDate("18-08-2026", today)).toBeNull();
    expect(validateBillDate("", today)).toBeNull();
    expect(validateBillDate("2024-12-31", today)).toBeNull();
  });
  it("noon-IST iso keeps the same IST day", () => {
    const iso = billDateToIso("2026-08-10");
    expect(new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })).toBe("2026-08-10");
  });
});

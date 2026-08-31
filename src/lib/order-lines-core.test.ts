import { describe, it, expect } from "vitest";
import { effectiveLineState, billableLines, pendingLines, computeBillTotals, validateBillDate, billDateToIso } from "./order-lines-core";
import type { OrderItem } from "./types";

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

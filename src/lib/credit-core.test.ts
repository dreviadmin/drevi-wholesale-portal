import { describe, it, expect } from "vitest";

import {
  computeCreditTotals,
  discountShareFor,
  returnedByBillLine,
  remainingReturnable,
  walletBalance,
  allocateConsumption,
  validateCreditAmount,
  type BillLine,
  type SourceBill,
} from "./credit-core";
import { computeBillTotals } from "./order-lines-core";
import type { OrderItem, Order } from "@/lib/types";

const line = (sku: string, qty: number, price: number): OrderItem =>
  ({ sku, title: sku, qty, unit_price: price, stock_state: "ready", restock_days: null, image_url: null }) as OrderItem;

const asBillLines = (items: OrderItem[]): BillLine[] => items.map((item, index) => ({ item, index }));

const req = (lines: BillLine[], qtys: number[]) =>
  lines.map((l, i) => ({ line: l, qty: qtys[i], restock: true, orderLineIndex: i })).filter((x) => x.qty > 0);

describe("credit money", () => {
  it("credits the plain line value when the bill had no discount or tax", () => {
    const items = [line("A", 2, 1000), line("B", 1, 500)];
    const bill: SourceBill = { subtotal: 2500, discount_amount: 0, tax_mode: "none", tax_rate: null };
    const c = computeCreditTotals(req(asBillLines(items), [2, 1]), bill);
    expect(c.sourceSubtotal).toBe(2500);
    expect(c.discountShare).toBe(0);
    expect(c.total).toBe(2500);
  });

  it("allocates the bill's discount pro-rata so a full return equals the bill total", () => {
    // The regression that matters: crediting raw unit prices hands back money
    // the buyer never paid.
    const items = [line("A", 10, 10000)];
    const order = { discount_type: "absolute", discount_value: 20000, tax_mode: "none", tax_rate: null, advance_amount: 0 } as unknown as Order;
    const billed = computeBillTotals(items, order, { discountApplied: 0, advanceApplied: 0 });
    expect(billed.total).toBe(80000);

    const bill: SourceBill = { subtotal: billed.subtotal, discount_amount: billed.discountAmount, tax_mode: billed.taxMode, tax_rate: billed.taxRate };
    const credit = computeCreditTotals(req(asBillLines(items), [10]), bill);
    expect(credit.total).toBe(billed.total);
  });

  it("returning every line equals the bill total for percent + exclusive tax", () => {
    const items = [line("A", 3, 2000), line("B", 2, 1500)];
    const order = { discount_type: "percent", discount_value: 10, tax_mode: "exclusive", tax_rate: 5, advance_amount: 0 } as unknown as Order;
    const billed = computeBillTotals(items, order, { discountApplied: 0, advanceApplied: 0 });
    const bill: SourceBill = { subtotal: billed.subtotal, discount_amount: billed.discountAmount, tax_mode: billed.taxMode, tax_rate: billed.taxRate };
    const credit = computeCreditTotals(req(asBillLines(items), [3, 2]), bill);
    expect(credit.total).toBe(billed.total);
  });

  it("returning every line equals the bill total for inclusive tax", () => {
    const items = [line("A", 4, 1250)];
    const order = { discount_type: "percent", discount_value: 20, tax_mode: "inclusive", tax_rate: 12, advance_amount: 0 } as unknown as Order;
    const billed = computeBillTotals(items, order, { discountApplied: 0, advanceApplied: 0 });
    const bill: SourceBill = { subtotal: billed.subtotal, discount_amount: billed.discountAmount, tax_mode: billed.taxMode, tax_rate: billed.taxRate };
    const credit = computeCreditTotals(req(asBillLines(items), [4]), bill);
    expect(credit.total).toBe(billed.total);
    expect(credit.taxAmount).toBe(billed.taxAmount);
  });

  it("credits a partial return proportionally, never the gross", () => {
    const items = [line("A", 10, 10000)];
    const bill: SourceBill = { subtotal: 100000, discount_amount: 20000, tax_mode: "none", tax_rate: null };
    const credit = computeCreditTotals(req(asBillLines(items), [5]), bill);
    expect(credit.sourceSubtotal).toBe(50000);
    expect(credit.discountShare).toBe(10000);
    expect(credit.total).toBe(40000); // what was actually collected for those five
  });

  it("carries hsn and the bill anchor onto every snapshot line", () => {
    const items = [{ ...line("A", 2, 100), hsn: "6204" } as OrderItem];
    const c = computeCreditTotals(req(asBillLines(items), [2]), { subtotal: 200, discount_amount: 0, tax_mode: "none", tax_rate: null });
    expect(c.items[0].hsn).toBe("6204");
    expect(c.items[0].bill_line_index).toBe(0);
  });

  it("discountShareFor is zero when the bill had no discount or an empty subtotal", () => {
    expect(discountShareFor({ subtotal: 0, discount_amount: 500 }, 100)).toBe(0);
    expect(discountShareFor({ subtotal: 1000, discount_amount: 0 }, 100)).toBe(0);
  });
});

describe("return caps", () => {
  const notes = [
    { id: "n1", status: "issued", order_bill_id: "b1", items: [{ bill_line_index: 0, qty: 2, sku: "A" }] },
    { id: "n2", status: "issued", order_bill_id: "b1", items: [{ bill_line_index: 0, qty: 1, sku: "A" }] },
    { id: "n3", status: "void", order_bill_id: "b1", items: [{ bill_line_index: 0, qty: 5, sku: "A" }] },
    { id: "n4", status: "issued", order_bill_id: "b2", items: [{ bill_line_index: 0, qty: 4, sku: "A" }] },
  ];

  it("sums issued returns per bill line and ignores voided notes", () => {
    const m = returnedByBillLine(notes);
    expect(m.get("b1:0")).toBe(3);
    expect(m.get("b2:0")).toBe(4);
  });

  it("keys per bill so the same index on another bill is independent", () => {
    const m = returnedByBillLine(notes);
    expect(m.get("b1:0")).not.toBe(m.get("b2:0"));
  });

  it("never offers more than what is left, and never a negative", () => {
    expect(remainingReturnable(10, 3)).toBe(7);
    expect(remainingReturnable(10, 10)).toBe(0);
    expect(remainingReturnable(10, 12)).toBe(0);
  });
});

describe("wallet", () => {
  const grants = [
    { id: "g1", total: 30000, status: "issued", effective_date: "2026-09-01", created_at: "2026-09-01T10:00:00Z" },
    { id: "g2", total: 10000, status: "issued", effective_date: "2026-09-05", created_at: "2026-09-05T10:00:00Z" },
    { id: "g3", total: 99999, status: "void", effective_date: "2026-09-06", created_at: "2026-09-06T10:00:00Z" },
  ];

  it("counts issued notes as the grant and ignores voided ones", () => {
    expect(walletBalance(grants, [])).toBe(40000);
  });

  it("subtracts consumption and adds back reversals", () => {
    const entries = [
      { id: "e1", delta: -25000, reason: "applied", effective_date: "2026-09-07", created_at: "2026-09-07T10:00:00Z" },
      { id: "e2", delta: 25000, reason: "unapplied", effective_date: "2026-09-08", created_at: "2026-09-08T10:00:00Z" },
      { id: "e3", delta: -5000, reason: "applied", effective_date: "2026-09-09", created_at: "2026-09-09T10:00:00Z" },
    ];
    expect(walletBalance(grants, entries)).toBe(35000);
  });

  it("coerces numerics that arrive as strings", () => {
    const g = [{ id: "g", total: "1500.50" as unknown as number, status: "issued", effective_date: "2026-09-01", created_at: "x" }];
    const e = [{ id: "e", delta: "-500.25" as unknown as number, reason: "applied", effective_date: "2026-09-02", created_at: "y" }];
    expect(walletBalance(g, e)).toBe(1000.25);
  });

  it("draws consumption from the oldest note first so each note shows what is left", () => {
    const entries = [{ id: "e1", delta: -35000, reason: "applied", effective_date: "2026-09-07", created_at: "2026-09-07T10:00:00Z" }];
    const a = allocateConsumption(grants, entries);
    expect(a.get("g1")).toEqual({ consumed: 30000, remaining: 0 });
    expect(a.get("g2")).toEqual({ consumed: 5000, remaining: 5000 });
    expect(a.has("g3")).toBe(false); // voided notes are not spendable
  });

  it("leaves every note whole when nothing has been spent", () => {
    const a = allocateConsumption(grants, []);
    expect(a.get("g1")!.remaining).toBe(30000);
    expect(a.get("g2")!.remaining).toBe(10000);
  });
});

describe("validateCreditAmount", () => {
  it("rejects zero, negatives and junk", () => {
    for (const bad of ["0", "-5", "abc", "", null]) {
      expect(validateCreditAmount(bad).ok).toBe(false);
    }
  });
  it("rejects more than the balance and accepts the balance itself", () => {
    expect(validateCreditAmount(5001, 5000).ok).toBe(false);
    expect(validateCreditAmount(5000, 5000)).toEqual({ ok: true, value: 5000 });
  });
  it("rounds to paise", () => {
    expect(validateCreditAmount(100.456)).toEqual({ ok: true, value: 100.46 });
  });
});

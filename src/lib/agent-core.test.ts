import { describe, it, expect } from "vitest";
import {
  commissionBase, commissionAmount, collectedShare, agentTotals, payoutCheck, isUnsuppliedLine,
} from "./agent-core";

describe("commissionBase", () => {
  it("is total − tax in every tax mode, which is the whole point", () => {
    // exclusive: net 100000 + 5% tax -> total 105000, tax 5000
    expect(commissionBase({ total_amount: 105000, tax_amount: 5000 })).toBe(100000);
    // none: total is the goods value
    expect(commissionBase({ total_amount: 100000, tax_amount: 0 })).toBe(100000);
    // inclusive: computeBillTotals sets total = net with the GST INSIDE it.
    // Paying on `total` here would pay commission on tax the house remits.
    expect(commissionBase({ total_amount: 100000, tax_amount: 4761.9 })).toBe(95238.1);
  });

  it("excludes goods that never shipped", () => {
    // One terminal order on prod carries exactly this shape.
    const order = {
      total_amount: 106195, tax_amount: 0,
      items: [
        { qty: 1, unit_price: 100000, line_state: "confirmed" },
        { qty: 1, unit_price: 6195, line_state: "hold" },
      ],
    };
    expect(commissionBase(order)).toBe(100000);
  });

  it("treats hold and pending alike, and nothing else", () => {
    expect(isUnsuppliedLine({ line_state: "hold" })).toBe(true);
    expect(isUnsuppliedLine({ line_state: "PENDING" })).toBe(true);
    expect(isUnsuppliedLine({ line_state: "confirmed" })).toBe(false);
    expect(isUnsuppliedLine({})).toBe(false);
  });

  it("never goes negative, and survives junk", () => {
    expect(commissionBase({ total_amount: 100, tax_amount: 0, items: [{ qty: 5, unit_price: 1000, line_state: "hold" }] })).toBe(0);
    expect(commissionBase({})).toBe(0);
    expect(commissionBase({ total_amount: null, tax_amount: undefined, items: null })).toBe(0);
  });
});

describe("commissionAmount", () => {
  it("multiplies to the paisa and clamps the percentage", () => {
    expect(commissionAmount(100000, 4)).toBe(4000);
    expect(commissionAmount(97466.67, 2.5)).toBe(2436.67);
    expect(commissionAmount(100000, 150)).toBe(100000);
    expect(commissionAmount(100000, -5)).toBe(0);
    expect(commissionAmount(-100, 4)).toBe(0);
  });
});

describe("collectedShare", () => {
  it("is the fraction of the order the buyer has actually paid", () => {
    expect(collectedShare({ total_amount: 100000, advance_amount: 25000 })).toBe(0.25);
    expect(collectedShare({ total_amount: 100000, advance_amount: 100000 })).toBe(1);
    expect(collectedShare({ total_amount: 100000, advance_amount: 0 })).toBe(0);
  });

  it("treats credit as a reduction of what is owed, never as money received", () => {
    // ₹60k written off, ₹40k actually paid — the buyer has settled everything
    // that was still owed, so the commission is fully payable.
    expect(collectedShare({ total_amount: 100000, advance_amount: 40000, credit_applied: 60000 })).toBe(1);

    // A goodwill note written off against a disputed order. The buyer paid
    // nothing and never will; counting the credit as cash made the whole
    // commission payable, and no clawback exists for a manual note.
    expect(collectedShare({ total_amount: 100000, advance_amount: 0, credit_applied: 100000 })).toBe(0);

    // A return credited to its own order. The buyer still owes ₹50k and has
    // paid ₹0 — the old maths called that half collected.
    expect(collectedShare({ total_amount: 100000, advance_amount: 0, credit_applied: 50000 })).toBe(0);

    // …and once they pay the rest, it is fully collected.
    expect(collectedShare({ total_amount: 100000, advance_amount: 50000, credit_applied: 50000 })).toBe(1);
  });

  it("never exceeds 1, and a zero-value order does not hold a payout hostage", () => {
    expect(collectedShare({ total_amount: 100000, advance_amount: 250000 })).toBe(1);
    expect(collectedShare({ total_amount: 0 })).toBe(1);
  });
});

describe("agentTotals", () => {
  it("separates earned from payable — they differ by 87% on the real book", () => {
    const t = agentTotals(
      [{ commission_amount: 4000, collected: 0.129 }],   // delivered, barely paid for
      [],
      [],
    );
    expect(t.earned).toBe(4000);
    expect(t.payable).toBe(516);
    expect(t.balance).toBe(516);
  });

  it("applies an adjustment to earned in full and to payable at its own collected share", () => {
    const t = agentTotals(
      [{ commission_amount: 4000, collected: 1 }],
      [{ delta: -800, collected: 1 }],                   // a return clawed back
      [{ amount: 1000 }],
    );
    expect(t.earned).toBe(3200);
    expect(t.payable).toBe(3200);
    expect(t.paid).toBe(1000);
    expect(t.balance).toBe(2200);
  });

  it("ignores voided payouts", () => {
    const t = agentTotals([{ commission_amount: 1000, collected: 1 }], [], [
      { amount: 400 }, { amount: 600, voided_at: "2026-09-23T00:00:00Z" },
    ]);
    expect(t.paid).toBe(400);
    expect(t.balance).toBe(600);
  });

  it("goes negative when a clawback lands after the agent was paid", () => {
    const t = agentTotals(
      [{ commission_amount: 4000, collected: 1 }],
      [{ delta: -3000, collected: 1 }],
      [{ amount: 4000 }],
    );
    expect(t.payable).toBe(1000);
    expect(t.balance).toBe(-3000);
  });

  it("is zero on an agent with nothing", () => {
    expect(agentTotals([], [], [])).toEqual({ earned: 0, payable: 0, paid: 0, balance: 0 });
  });
});

describe("payoutCheck", () => {
  const T = (earned: number, payable: number, paid: number) => ({ earned, payable, paid, balance: payable - paid });

  it("caps at payable, not at earned", () => {
    expect(payoutCheck(T(4000, 516, 0), 500)).toEqual({ ok: true });
    expect(payoutCheck(T(4000, 516, 0), 516)).toEqual({ ok: true });
    const over = payoutCheck(T(4000, 516, 0), 4000);
    expect(over.ok).toBe(false);
    expect(over.error).toContain("516");
  });

  it("tells the three zero-balance stories apart", () => {
    // Earned but the buyer has not paid — the common case, and the one the
    // first version described as "has been paid", which was simply untrue.
    const unpaid = payoutCheck(T(3030, 0, 0), 1000);
    expect(unpaid.ok).toBe(false);
    expect(unpaid.error).toContain("buyers on these orders have not paid");

    const nothing = payoutCheck(T(0, 0, 0), 1000);
    expect(nothing.error).toContain("Nothing earned yet");

    const settled = payoutCheck(T(3030, 3030, 3030), 100);
    expect(settled.error).toContain("paid for everything collected");
  });

  it("explains a negative balance as a clawback that carries forward", () => {
    const ahead = payoutCheck(T(1000, 1000, 4000), 100);
    expect(ahead.ok).toBe(false);
    expect(ahead.error).toContain("ahead");
    expect(ahead.error).toContain("next commission");
  });

  it("refuses a zero or negative amount", () => {
    expect(payoutCheck(T(4000, 4000, 0), 0).ok).toBe(false);
    expect(payoutCheck(T(4000, 4000, 0), -50).ok).toBe(false);
  });
});

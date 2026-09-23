// Agent commission arithmetic. PURE, so every rule below is testable without a
// database — the same reason credit-core.ts sits apart from its actions.

/** A line as it sits in orders.items. Only the fields the base depends on. */
export interface CommissionLine {
  qty?: number | null;
  unit_price?: number | null;
  line_state?: string | null;
}

export interface CommissionOrder {
  total_amount?: number | null;
  tax_amount?: number | null;
  items?: CommissionLine[] | null;
}

const money = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Lines that never shipped and must not earn commission.
 *
 * updateOrderItems sums EVERY line into total_amount, while billing
 * deliberately bills only the confirmed ones — and setLineState refuses to
 * change a line once the order is terminal, so a held line is frozen inside a
 * delivered order's total forever. One terminal order on prod carries ₹6,195
 * of goods that never left the building.
 */
export function isUnsuppliedLine(line: CommissionLine): boolean {
  const s = (line.line_state ?? "").trim().toLowerCase();
  return s === "hold" || s === "pending";
}

/**
 * What the commission is charged on.
 *
 *   base = (total_amount − tax_amount) − Σ(unsupplied lines)
 *
 * `total_amount − tax_amount` is the only expression correct in all three tax
 * modes. Under 'exclusive' it is net+tax−tax; under 'none' it is net−0; under
 * 'inclusive' computeBillTotals sets total = net with the GST still INSIDE it,
 * so subtracting tax_amount is what stops the agent being paid commission on
 * money the house remits to the government. No prod order is 'inclusive'
 * today, but the exhibition form, the cart and the order editor all offer it.
 *
 * The unsupplied deduction is at raw line value rather than a discount-adjusted
 * share. It is deliberately the simpler of the two: the discount is an
 * order-level figure and apportioning it to a line that was never billed
 * invents a number nobody can check against a document.
 */
export function commissionBase(order: CommissionOrder): number {
  const gross = num(order.total_amount) - num(order.tax_amount);
  const unsupplied = (order.items ?? [])
    .filter(isUnsuppliedLine)
    .reduce((s, l) => s + num(l.qty) * num(l.unit_price), 0);
  return money(Math.max(0, gross - unsupplied));
}

/** base × pct, to the paisa. */
export function commissionAmount(base: number, pct: number): number {
  const p = Math.min(100, Math.max(0, num(pct)));
  return money(Math.max(0, num(base)) * (p / 100));
}

export interface AgentTotals {
  /** Accrued on delivery, plus every signed adjustment. */
  earned: number;
  /** The share of earned the buyer has actually paid for. */
  payable: number;
  paid: number;
  /** payable − paid. Negative means the agent has been paid ahead. */
  balance: number;
}

export interface CommissionRow {
  commission_amount?: number | null;
  /** The order's collected share, 0..1 — see collectedShare(). */
  collected?: number | null;
}

/**
 * How much of an order the buyer has actually paid, as a fraction.
 *
 * Commission is EARNED on delivery but only PAYABLE as the money arrives
 * (Ansh, 23 Sep): 87% of delivered value on prod is still outstanding, so
 * paying on delivery alone would fund agents out of pocket.
 *
 * credit_applied counts as collected. A return that funded it reduces the
 * commission through its own adjustment row, so treating the credit as payment
 * here does not double-count — it is the ADJUSTMENT that carries the clawback,
 * not this fraction.
 */
export function collectedShare(order: {
  total_amount?: number | null;
  advance_amount?: number | null;
  credit_applied?: number | null;
}): number {
  const total = num(order.total_amount);
  if (total <= 0) return 1; // nothing to collect — do not hold the payout hostage
  const credit = Math.max(0, num(order.credit_applied));
  // Credit REDUCES what is owed; it is not money received.
  //
  // Counting it as collected paid commission on cash that never arrived and
  // never would: a goodwill note written off against a disputed order made the
  // order read 100% collected, and adjustForReturn only fires on kind='return',
  // so no clawback ever balanced it. A return credited to its own order did the
  // same thing more quietly — payable rose on the half the buyer had not paid.
  //
  // Dividing by what is left to pay keeps both honest and still reaches 1 the
  // moment the buyer actually settles the remainder.
  const owed = Math.max(0, total - credit);
  if (owed <= 0) return 0;
  return Math.min(1, Math.max(0, num(order.advance_amount) / owed));
}

/**
 * Roll a set of accruals, adjustments and payouts into the four figures the
 * agent page shows. One "balance" would have been misleading when earned and
 * payable differ by 87%.
 *
 * Adjustments land on EARNED in full and on PAYABLE at the same collected
 * share as the accrual they belong to, so a clawback cannot make payable drift
 * above earned.
 */
export function agentTotals(
  commissions: CommissionRow[],
  adjustments: { delta?: number | null; collected?: number | null }[],
  payments: { amount?: number | null; voided_at?: string | null }[],
): AgentTotals {
  let earned = 0;
  let payable = 0;
  for (const c of commissions) {
    const amt = num(c.commission_amount);
    earned += amt;
    payable += amt * Math.min(1, Math.max(0, num(c.collected)));
  }
  for (const a of adjustments) {
    const d = num(a.delta);
    earned += d;
    payable += d * Math.min(1, Math.max(0, num(a.collected)));
  }
  const paid = payments.filter((p) => !p.voided_at).reduce((s, p) => s + num(p.amount), 0);
  return {
    earned: money(earned),
    payable: money(payable),
    paid: money(paid),
    balance: money(payable - paid),
  };
}

/**
 * What a payout may be for. Takes the whole totals object rather than just the
 * balance, because a zero balance has three different causes and only one of
 * them is "already paid".
 *
 * Capped at the payable balance, never at earned — that is the whole point of
 * the split. A balance at or below zero blocks the payout outright: it means
 * the agent has already been paid for everything collected, usually because a
 * return clawed commission back after they were paid. The debit carries
 * forward and nets against their next order rather than being written off.
 */
export function payoutCheck(totals: AgentTotals, amount: number): { ok: boolean; error?: string } {
  const b = money(num(totals.balance));
  const a = money(num(amount));
  if (a <= 0) return { ok: false, error: "Enter an amount" };

  if (b < 0) {
    return {
      ok: false,
      error: `This agent is ₹${Math.abs(b).toLocaleString("en-IN")} ahead after a clawback. It nets against their next commission.`,
    };
  }
  if (b === 0) {
    // Two very different situations reach zero, and telling someone their
    // agent "has been paid" when the agent has had nothing is the kind of
    // wrong message that gets a feature distrusted. The discriminator is
    // whether anything has gone out at all.
    if (num(totals.paid) === 0 && num(totals.earned) > 0) {
      return { ok: false, error: "Nothing payable yet — the buyers on these orders have not paid. Commission becomes payable as they do." };
    }
    if (num(totals.earned) === 0) {
      return { ok: false, error: "Nothing earned yet — commission is earned when one of their orders is delivered." };
    }
    return { ok: false, error: "Nothing payable — this agent has been paid for everything collected so far." };
  }
  if (a > b + 0.001) return { ok: false, error: `Only ₹${b.toLocaleString("en-IN")} is payable right now.` };
  return { ok: true };
}

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { commissionBase, commissionAmount, collectedShare, agentTotals, type AgentTotals } from "@/lib/agent-core";

// The write side of agent commission. Kept out of the route's actions file so
// orders/actions.ts and credit-notes/actions.ts can both reach it without
// importing a "use server" module from another route.

/**
 * Accrue the commission for an order that has just reached a terminal state.
 *
 * Called from applyStatus INSIDE its compare-and-swap, so only the transition
 * that actually won the update gets here — the same protection that stops
 * stock leaving the shelf twice. unique(order_id) on agent_commissions is the
 * second belt: a re-entry into a terminal state cannot pay twice.
 *
 * Never throws. A commission that fails to post must not roll back a delivery
 * that has already happened — the order is the fact, the accrual is the
 * bookkeeping, and an unaccrued order is visible on the agent page as a gap
 * rather than being silently lost.
 */
export async function accrueCommission(
  orderId: string,
  trigger: "delivered" | "fulfilled",
  staffEmail: string,
): Promise<{ accrued: boolean; amount?: number; error?: string }> {
  const admin = createAdminClient();
  try {
    const [{ data: order }, { data: link }] = await Promise.all([
      admin.from("orders").select("id, order_number, total_amount, tax_amount, items, lines_rev").eq("id", orderId).maybeSingle(),
      // The association lives in its own staff-only table (0067) so a buyer
      // cannot read their own agent's rate off the order row.
      admin.from("order_agents").select("agent_id, commission_pct").eq("order_id", orderId).maybeSingle(),
    ]);
    if (!order) return { accrued: false, error: "Order not found" };
    if (!link?.agent_id) return { accrued: false };

    const pct = Number(link.commission_pct ?? 0);
    if (!(pct > 0)) return { accrued: false };

    const base = commissionBase(order);
    const amount = commissionAmount(base, pct);

    const { error } = await admin.from("agent_commissions").insert({
      agent_id: link.agent_id,
      order_id: orderId,
      commission_base: base,
      commission_pct: pct,
      commission_amount: amount,
      lines_rev: Number(order.lines_rev) || 0,
      accrued_on: trigger,
      accrued_by: staffEmail,
    });
    // 23505 = the unique(order_id) guard. Already accrued is success, not failure.
    if (error && error.code !== "23505") return { accrued: false, error: error.message };
    if (error) return { accrued: false };

    // Goods can come back before the order is marked delivered — the return
    // flow only needs a bill, not a terminal status. Those notes were raised
    // when there was no accrual to reduce, so sweep them now. adjustForReturn
    // is idempotent on (agent_id, credit_note_id, reason), so this is a no-op
    // on the ordinary path where nothing has been returned yet.
    const { data: priorReturns } = await admin
      .from("credit_notes")
      .select("id")
      .eq("order_id", orderId)
      .eq("kind", "return")
      .eq("status", "issued");
    for (const n of priorReturns ?? []) await adjustForReturn(n.id, staffEmail);

    await writeAuditEvent({
      eventType: "agent_commission_accrued",
      notes: `${order.order_number}: ₹${amount} to agent ${link.agent_id} (${pct}% of ₹${base}) on ${trigger} by ${staffEmail}`,
    });
    return { accrued: true, amount };
  } catch (e) {
    return { accrued: false, error: (e as Error).message };
  }
}

/**
 * Claw back an agent's share of a return.
 *
 * Netted from the credit note itself, never from orders.credit_applied: credit
 * is a PARTY-level wallet and settleReturn lets a note raised on order A be
 * set against order B, so using credit_applied would claw the same return back
 * twice — once on each order.
 *
 * unique(agent_id, credit_note_id) makes a re-run a no-op.
 */
export async function adjustForReturn(
  creditNoteId: string,
  staffEmail: string,
): Promise<{ adjusted: boolean; delta?: number; error?: string }> {
  const admin = createAdminClient();
  try {
    const { data: note } = await admin
      .from("credit_notes")
      .select("id, note_number, order_id, subtotal, total, tax_amount, kind, status")
      .eq("id", creditNoteId)
      .maybeSingle();
    if (!note || note.kind !== "return" || note.status !== "issued" || !note.order_id) return { adjusted: false };

    const { data: accrual } = await admin
      .from("agent_commissions")
      .select("id, agent_id, commission_pct")
      .eq("order_id", note.order_id)
      .maybeSingle();
    if (!accrual) return { adjusted: false }; // no agent, or not delivered yet

    // total − tax, the exact mirror of commissionBase's total_amount −
    // tax_amount. NOT note.subtotal: under tax_mode 'inclusive' the note's
    // subtotal still carries the GST inside it, exactly as the order's total
    // does, so clawing back on it would reverse more than was ever accrued —
    // a fully returned 18% order landed at −₹720 of earned instead of zero,
    // and that phantom debit then blocked every later payout.
    //
    // Identical to subtotal under 'none' and 'exclusive', where
    // total = subtotal + tax.
    const returnedBase = (Number(note.total) || 0) - (Number(note.tax_amount) || 0);
    const delta = -commissionAmount(Math.max(0, returnedBase), Number(accrual.commission_pct) || 0);
    if (delta === 0) return { adjusted: false };

    const { error } = await admin.from("agent_adjustments").insert({
      agent_id: accrual.agent_id,
      order_id: note.order_id,
      commission_id: accrual.id,
      delta,
      reason: "return",
      credit_note_id: note.id,
      note: `${note.note_number} returned`,
      created_by: staffEmail,
    });
    if (error && error.code !== "23505") return { adjusted: false, error: error.message };
    if (error) return { adjusted: false };

    await writeAuditEvent({
      eventType: "agent_commission_adjusted",
      notes: `${note.note_number}: ₹${delta} against agent ${accrual.agent_id} by ${staffEmail}`,
    });
    return { adjusted: true, delta };
  } catch (e) {
    return { adjusted: false, error: (e as Error).message };
  }
}

export interface AgentOrderRow {
  orderId: string;
  orderNumber: string;
  buyerName: string | null;
  status: string;
  accruedOn: string;
  accruedAt: string;
  base: number;
  pct: number;
  amount: number;
  /** 0..1 — how much of the order the buyer has paid. */
  collected: number;
  payable: number;
  adjustments: { delta: number; reason: string; note: string | null; at: string }[];
  /** The order's items changed after the accrual — the figure is stale. */
  revisedSinceAccrual: boolean;
}

/**
 * Everything the agent page shows. One read, because earned, payable, the
 * order breakdown and the revision check all come from the same three tables.
 */
export async function loadAgentAccount(agentId: string): Promise<{
  totals: AgentTotals;
  orders: AgentOrderRow[];
  payments: { id: string; amount: number; method: string | null; reference: string | null; paidOn: string; note: string | null; voidedAt: string | null; voidReason: string | null; createdBy: string | null }[];
}> {
  const admin = createAdminClient();
  const [{ data: comms }, { data: adjs }, { data: pays }] = await Promise.all([
    admin.from("agent_commissions").select("*").eq("agent_id", agentId).order("accrued_at", { ascending: false }),
    admin.from("agent_adjustments").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }),
    admin.from("agent_payments").select("*").eq("agent_id", agentId).order("paid_on", { ascending: false }),
  ]);

  const orderIds = [...new Set((comms ?? []).map((c) => c.order_id))];
  const { data: orders } = orderIds.length
    ? await admin
        .from("orders")
        .select("id, order_number, status, total_amount, advance_amount, credit_applied, lines_rev, buyer_business_name")
        .in("id", orderIds)
    : { data: [] as Record<string, unknown>[] };
  const orderById = new Map((orders ?? []).map((o) => [o.id as string, o]));

  const collectedFor = (orderId: string) => {
    const o = orderById.get(orderId);
    return o ? collectedShare(o as { total_amount?: number; advance_amount?: number; credit_applied?: number }) : 0;
  };

  const rows: AgentOrderRow[] = (comms ?? []).map((c) => {
    const o = orderById.get(c.order_id) as Record<string, unknown> | undefined;
    const collected = collectedFor(c.order_id);
    const mine = (adjs ?? []).filter((a) => a.commission_id === c.id);
    const amount = Number(c.commission_amount) || 0;
    const adjTotal = mine.reduce((s, a) => s + (Number(a.delta) || 0), 0);
    return {
      orderId: c.order_id,
      orderNumber: (o?.order_number as string) ?? "—",
      buyerName: (o?.buyer_business_name as string) ?? null,
      status: (o?.status as string) ?? "—",
      accruedOn: c.accrued_on,
      accruedAt: c.accrued_at,
      base: Number(c.commission_base) || 0,
      pct: Number(c.commission_pct) || 0,
      amount,
      collected,
      payable: Math.round((amount + adjTotal) * collected * 100) / 100,
      adjustments: mine.map((a) => ({ delta: Number(a.delta) || 0, reason: a.reason, note: a.note, at: a.created_at })),
      // lines_rev is bumped by every writer of orders.items, so a difference
      // means the order was edited after the commission was frozen.
      revisedSinceAccrual: (Number(o?.lines_rev) || 0) > (Number(c.lines_rev) || 0),
    };
  });

  const totals = agentTotals(
    (comms ?? []).map((c) => ({ commission_amount: c.commission_amount, collected: collectedFor(c.order_id) })),
    (adjs ?? []).map((a) => ({ delta: a.delta, collected: a.order_id ? collectedFor(a.order_id) : 1 })),
    (pays ?? []).map((p) => ({ amount: p.amount, voided_at: p.voided_at })),
  );

  return {
    totals,
    orders: rows,
    payments: (pays ?? []).map((p) => ({
      id: p.id, amount: Number(p.amount) || 0, method: p.method, reference: p.reference,
      paidOn: p.paid_on, note: p.note, voidedAt: p.voided_at, voidReason: p.void_reason, createdBy: p.created_by,
    })),
  };
}

/**
 * Give back a clawback when the return behind it is voided.
 *
 * voidCreditNote un-issues the note, and without this the agent's commission
 * stayed reduced for a return that no longer exists. Additive: the original
 * clawback remains on the statement with its reversal underneath, rather than
 * disappearing as if it had never been made. unique(agent_id, credit_note_id,
 * reason) allows exactly one of each and blocks a second reversal.
 */
export async function reverseReturnAdjustment(
  creditNoteId: string,
  staffEmail: string,
): Promise<{ reversed: boolean; delta?: number; error?: string }> {
  const admin = createAdminClient();
  try {
    const { data: original } = await admin
      .from("agent_adjustments")
      .select("id, agent_id, order_id, commission_id, delta, note")
      .eq("credit_note_id", creditNoteId)
      .eq("reason", "return")
      .maybeSingle();
    if (!original) return { reversed: false };

    const delta = -(Number(original.delta) || 0);
    if (delta === 0) return { reversed: false };

    const { error } = await admin.from("agent_adjustments").insert({
      agent_id: original.agent_id,
      order_id: original.order_id,
      commission_id: original.commission_id,
      delta,
      reason: "correction",
      credit_note_id: creditNoteId,
      note: `${original.note ?? "return"} — voided, commission restored`,
      created_by: staffEmail,
    });
    if (error && error.code !== "23505") return { reversed: false, error: error.message };
    if (error) return { reversed: false };

    await writeAuditEvent({
      eventType: "agent_commission_adjusted",
      notes: `credit note ${creditNoteId} voided: ₹${delta} restored to agent ${original.agent_id} by ${staffEmail}`,
    });
    return { reversed: true, delta };
  } catch (e) {
    return { reversed: false, error: (e as Error).message };
  }
}

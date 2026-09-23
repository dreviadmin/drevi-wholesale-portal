"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireStaff } from "@/lib/staff";
import { writeAuditEvent } from "@/lib/audit";
import { loadAgentAccount } from "@/lib/agent-ledger";
import { payoutCheck } from "@/lib/agent-core";

export interface AgentInput {
  name: string;
  phone?: string;
  email?: string;
  city?: string;
  address?: string;
  defaultCommissionPct: number;
  notes?: string;
}

const clean = (v?: string) => (v ?? "").trim() || null;
const pct = (v: unknown) => Math.min(100, Math.max(0, Number(v) || 0));

export async function createAgent(input: AgentInput): Promise<{ ok: boolean; error?: string; id?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  if (!input.name?.trim()) return { ok: false, error: "Name is required" };

  const admin = createAdminClient();
  const { data, error } = await admin.from("agents").insert({
    name: input.name.trim(),
    phone: clean(input.phone), email: clean(input.email),
    city: clean(input.city), address: clean(input.address),
    default_commission_pct: pct(input.defaultCommissionPct),
    notes: clean(input.notes),
    created_by: staff.email,
  }).select("id").single();
  if (error) return { ok: false, error: error.message };

  await writeAuditEvent({ eventType: "agent_created", staffUserId: staff.id, notes: `${input.name.trim()} at ${pct(input.defaultCommissionPct)}% by ${staff.email}` });
  revalidatePath("/admin/agents");
  return { ok: true, id: data.id };
}

export async function updateAgent(id: string, input: Partial<AgentInput> & { active?: boolean }): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const admin = createAdminClient();

  // Only fields the form actually supplied — a blank box must not wipe what is
  // already there (the §5.9 rule the master editor follows).
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) {
    if (!input.name.trim()) return { ok: false, error: "Name cannot be blank" };
    patch.name = input.name.trim();
  }
  for (const [k, col] of [["phone", "phone"], ["email", "email"], ["city", "city"], ["address", "address"], ["notes", "notes"]] as const) {
    if (input[k as keyof AgentInput] !== undefined) patch[col] = clean(input[k as keyof AgentInput] as string);
  }
  if (input.defaultCommissionPct !== undefined) patch.default_commission_pct = pct(input.defaultCommissionPct);
  if (input.active !== undefined) patch.active = input.active;

  const { error } = await admin.from("agents").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };

  await writeAuditEvent({ eventType: "agent_updated", staffUserId: staff.id, notes: `agent ${id}: ${Object.keys(patch).filter((k) => k !== "updated_at").join(", ")} by ${staff.email}` });
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
  return { ok: true };
}

/**
 * Put an agent on an order — what Rakesh does at confirmation, and can redo
 * at any time afterwards.
 *
 * `alsoLinkBuyer` is his call, not an automatic consequence: a one-off
 * introduction is not the same as the buyer belonging to that agent from now
 * on (Ansh, 23 Sep).
 *
 * Refused once the commission has accrued. The accrual is a frozen snapshot
 * and silently re-pointing it at a different agent — or a different rate —
 * would move money between people with nothing recording it. Reverse it with
 * an adjustment instead.
 */
export async function setOrderAgent(
  orderId: string,
  agentId: string | null,
  commissionPct: number | null,
  alsoLinkBuyer: boolean,
): Promise<{ ok: boolean; error?: string; accrued?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const admin = createAdminClient();

  const { data: accrued } = await admin.from("agent_commissions").select("id").eq("order_id", orderId).maybeSingle();
  if (accrued) return { ok: false, error: "Commission has already been accrued on this order — adjust it on the agent's page instead." };

  const { data: order } = await admin.from("orders").select("id, order_number, buyer_id").eq("id", orderId).maybeSingle();
  if (!order) return { ok: false, error: "Order not found" };

  let resolvedPct: number | null = null;
  if (agentId) {
    const { data: agent } = await admin.from("agents").select("id, name, default_commission_pct, active").eq("id", agentId).maybeSingle();
    if (!agent) return { ok: false, error: "Agent not found" };
    if (!agent.active) return { ok: false, error: `${agent.name} is inactive — reactivate them first.` };
    resolvedPct = commissionPct == null ? pct(agent.default_commission_pct) : pct(commissionPct);
  }

  // Its own table (0067), not a column on orders — a buyer can read their own
  // order row, and PostgREST returns every column of a row it lets you see.
  const { error } = agentId
    ? (await admin.from("order_agents").upsert(
        { order_id: orderId, agent_id: agentId, commission_pct: resolvedPct ?? 0, set_by: staff.email, set_at: new Date().toISOString() },
        { onConflict: "order_id" },
      ))
    : (await admin.from("order_agents").delete().eq("order_id", orderId));
  if (error) return { ok: false, error: error.message };

  if (alsoLinkBuyer && order.buyer_id) {
    const { error: bErr } = agentId
      ? (await admin.from("buyer_agents").upsert(
          { buyer_id: order.buyer_id, agent_id: agentId, set_by: staff.email, set_at: new Date().toISOString() },
          { onConflict: "buyer_id" },
        ))
      : (await admin.from("buyer_agents").delete().eq("buyer_id", order.buyer_id));
    if (bErr) return { ok: false, error: `Order updated, but linking the buyer failed: ${bErr.message}` };
  }

  // An order that is ALREADY terminal has no transition left to fire, so
  // attaching an agent to one would have earned them nothing and said nothing
  // about it. Accrue here instead — unique(order_id) keeps it to one, and
  // clearing the agent obviously accrues nothing.
  let accruedNow: number | undefined;
  if (agentId) {
    const { data: st } = await admin.from("orders").select("status").eq("id", orderId).maybeSingle();
    if (st?.status === "delivered" || st?.status === "fulfilled") {
      const { accrueCommission } = await import("@/lib/agent-ledger");
      const res = await accrueCommission(orderId, st.status, staff.email);
      if (res.accrued) accruedNow = res.amount;
    }
  }

  await writeAuditEvent({
    eventType: "order_agent_set",
    staffUserId: staff.id,
    notes: `${order.order_number}: agent ${agentId ?? "cleared"}${resolvedPct != null ? ` at ${resolvedPct}%` : ""}${alsoLinkBuyer ? " (also linked to the buyer)" : ""} by ${staff.email}`,
  });
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/agents");
  return { ok: true, ...(accruedNow != null ? { accrued: accruedNow } : {}) };
}

/** The buyer page's own control — same relation, no order involved. */
export async function setBuyerAgent(buyerId: string, agentId: string | null): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const admin = createAdminClient();
  const { error } = agentId
    ? (await admin.from("buyer_agents").upsert(
        { buyer_id: buyerId, agent_id: agentId, set_by: staff.email, set_at: new Date().toISOString() },
        { onConflict: "buyer_id" },
      ))
    : (await admin.from("buyer_agents").delete().eq("buyer_id", buyerId));
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "buyer_profile_updated", buyerId, staffUserId: staff.id, notes: `agent ${agentId ?? "cleared"} by ${staff.email}` });
  revalidatePath(`/admin/buyers/${buyerId}`);
  return { ok: true };
}

export async function recordAgentPayment(input: {
  agentId: string; amount: number; method?: string; reference?: string; paidOn?: string; note?: string; clientRef: string;
}): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const admin = createAdminClient();

  // Idempotent on clientRef, like settle_return: a double tap or a retry after
  // a dropped response resolves to the row the first attempt wrote.
  const { data: existing } = await admin.from("agent_payments").select("id").eq("client_ref", input.clientRef).maybeSingle();
  if (existing) return { ok: true };

  // Checked against PAYABLE, not earned — the whole point of the split.
  const { totals } = await loadAgentAccount(input.agentId);
  const check = payoutCheck(totals, input.amount);
  if (!check.ok) return { ok: false, error: check.error };

  const { error } = await admin.from("agent_payments").insert({
    agent_id: input.agentId,
    amount: Math.round(input.amount * 100) / 100,
    method: clean(input.method), reference: clean(input.reference),
    paid_on: input.paidOn || new Date().toISOString().slice(0, 10),
    note: clean(input.note),
    client_ref: input.clientRef,
    created_by: staff.email,
  });
  if (error) return { ok: false, error: error.message };

  await writeAuditEvent({ eventType: "agent_payment_recorded", staffUserId: staff.id, notes: `₹${input.amount} to agent ${input.agentId}${input.method ? ` by ${input.method}` : ""} — recorded by ${staff.email}` });
  revalidatePath(`/admin/agents/${input.agentId}`);
  revalidatePath("/admin/agents");
  return { ok: true };
}

/** Voided and kept, never deleted — the rule every money document here follows. */
export async function voidAgentPayment(paymentId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  if (!reason.trim()) return { ok: false, error: "Give a reason" };
  const admin = createAdminClient();

  const { data: won } = await admin
    .from("agent_payments")
    .update({ voided_at: new Date().toISOString(), voided_by: staff.email, void_reason: reason.trim() })
    .eq("id", paymentId)
    .is("voided_at", null)
    .select("id, agent_id, amount")
    .maybeSingle();
  if (!won) return { ok: false, error: "This payment was already voided." };

  await writeAuditEvent({ eventType: "agent_payment_voided", staffUserId: staff.id, notes: `₹${won.amount} to agent ${won.agent_id} voided by ${staff.email} — ${reason.trim()}` });
  revalidatePath(`/admin/agents/${won.agent_id}`);
  return { ok: true };
}

/** For the pickers: active agents, cheapest possible shape. */
export async function listAgents(): Promise<{ id: string; name: string; defaultPct: number }[]> {
  try { await requireStaff(); } catch { return []; }
  const admin = createAdminClient();
  const { data } = await admin.from("agents").select("id, name, default_commission_pct").eq("active", true).order("name");
  return (data ?? []).map((a) => ({ id: a.id, name: a.name, defaultPct: Number(a.default_commission_pct) || 0 }));
}

/**
 * A hand-written correction on an agent's account.
 *
 * The only other writers of agent_adjustments are the two credit-note hooks,
 * which means an order revised AFTER its commission was frozen showed a
 * "revised" flag with nothing anyone could do about it — the accrual is a
 * snapshot and setOrderAgent refuses to touch a frozen one, correctly. This is
 * the pressure valve: signed, reasoned, attributed, and additive like every
 * other movement here.
 *
 * Deliberately NOT an edit of the accrual. The frozen figure is what was
 * earned on the day; a correction is a second fact, not a rewriting of the
 * first.
 */
export async function addAgentAdjustment(input: {
  agentId: string;
  /** Signed: negative claws back, positive adds. */
  delta: number;
  note: string;
  /** Optional — an order ties the correction to that order's collected share. */
  orderId?: string | null;
  reason?: "manual" | "order_revised";
}): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const delta = Math.round((Number(input.delta) || 0) * 100) / 100;
  if (delta === 0) return { ok: false, error: "Enter an amount — positive adds, negative claws back" };
  if (!input.note?.trim()) return { ok: false, error: "Say why. An unexplained movement on someone's account is worse than none." };

  const admin = createAdminClient();
  // When an order is named, hang the adjustment off its accrual so it picks up
  // that order's collected share rather than being treated as fully payable.
  let commissionId: string | null = null;
  if (input.orderId) {
    const { data: acc } = await admin
      .from("agent_commissions")
      .select("id, agent_id")
      .eq("order_id", input.orderId)
      .maybeSingle();
    if (!acc) return { ok: false, error: "That order has no commission on it." };
    if (acc.agent_id !== input.agentId) return { ok: false, error: "That order belongs to a different agent." };
    commissionId = acc.id;
  }

  const { error } = await admin.from("agent_adjustments").insert({
    agent_id: input.agentId,
    order_id: input.orderId ?? null,
    commission_id: commissionId,
    delta,
    reason: input.reason ?? "manual",
    note: input.note.trim(),
    created_by: staff.email,
  });
  if (error) return { ok: false, error: error.message };

  await writeAuditEvent({
    eventType: "agent_commission_adjusted",
    staffUserId: staff.id,
    notes: `manual ₹${delta} on agent ${input.agentId}${input.orderId ? ` (order ${input.orderId})` : ""} by ${staff.email} — ${input.note.trim()}`,
  });
  revalidatePath(`/admin/agents/${input.agentId}`);
  revalidatePath("/admin/agents");
  return { ok: true };
}

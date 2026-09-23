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
): Promise<{ ok: boolean; error?: string }> {
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

  const { error } = await admin
    .from("orders")
    .update({ agent_id: agentId, agent_commission_pct: resolvedPct })
    .eq("id", orderId);
  if (error) return { ok: false, error: error.message };

  if (alsoLinkBuyer && order.buyer_id) {
    const { error: bErr } = await admin.from("buyers").update({ agent_id: agentId }).eq("id", order.buyer_id);
    if (bErr) return { ok: false, error: `Order updated, but linking the buyer failed: ${bErr.message}` };
  }

  await writeAuditEvent({
    eventType: "order_agent_set",
    staffUserId: staff.id,
    notes: `${order.order_number}: agent ${agentId ?? "cleared"}${resolvedPct != null ? ` at ${resolvedPct}%` : ""}${alsoLinkBuyer ? " (also linked to the buyer)" : ""} by ${staff.email}`,
  });
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/agents");
  return { ok: true };
}

/** The buyer page's own control — same relation, no order involved. */
export async function setBuyerAgent(buyerId: string, agentId: string | null): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const admin = createAdminClient();
  const { error } = await admin.from("buyers").update({ agent_id: agentId }).eq("id", buyerId);
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

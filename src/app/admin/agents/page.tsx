import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectedShare, agentTotals } from "@/lib/agent-core";
import { AgentsView, type AgentRow } from "./AgentsView";

export const dynamic = "force-dynamic";

// Agents (0064). Every figure on this list is derived from the three ledger
// tables on each read — no balance column exists, because two caches in this
// codebase have already drifted from the ledger behind them.
export default async function AgentsPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const [{ data: agents }, { data: comms }, { data: adjs }, { data: pays }, { data: buyers }] = await Promise.all([
    admin.from("agents").select("*").order("active", { ascending: false }).order("name"),
    admin.from("agent_commissions").select("agent_id, order_id, commission_amount"),
    admin.from("agent_adjustments").select("agent_id, order_id, delta"),
    admin.from("agent_payments").select("agent_id, amount, voided_at"),
    admin.from("buyers").select("id, agent_id").not("agent_id", "is", null),
  ]);

  // One orders read for every accrual on the board, so the collected share —
  // which is what separates earned from payable — is computed from the same
  // numbers the order page shows.
  const orderIds = [...new Set([...(comms ?? []).map((c) => c.order_id), ...(adjs ?? []).map((a) => a.order_id).filter(Boolean)])] as string[];
  type OrderShare = { id: string; total_amount: number | null; advance_amount: number | null; credit_applied: number | null };
  const { data: orders } = orderIds.length
    ? await admin.from("orders").select("id, total_amount, advance_amount, credit_applied").in("id", orderIds)
    : { data: [] as OrderShare[] };
  const shareBy = new Map((orders ?? []).map((o) => [o.id, collectedShare(o)]));

  const rows: AgentRow[] = (agents ?? []).map((a) => {
    const mine = (comms ?? []).filter((c) => c.agent_id === a.id);
    const t = agentTotals(
      mine.map((c) => ({ commission_amount: c.commission_amount, collected: shareBy.get(c.order_id) ?? 0 })),
      (adjs ?? []).filter((x) => x.agent_id === a.id).map((x) => ({ delta: x.delta, collected: x.order_id ? shareBy.get(x.order_id) ?? 0 : 1 })),
      (pays ?? []).filter((p) => p.agent_id === a.id),
    );
    return {
      id: a.id,
      name: a.name,
      phone: a.phone,
      city: a.city,
      defaultPct: Number(a.default_commission_pct) || 0,
      active: a.active,
      orders: mine.length,
      buyers: (buyers ?? []).filter((b) => b.agent_id === a.id).length,
      ...t,
    };
  });

  return <AgentsView rows={rows} />;
}

import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { collectedShare, agentTotals } from "@/lib/agent-core";
import { AgentsView, type AgentRow } from "./AgentsView";

export const dynamic = "force-dynamic";

// Agents (0064). Every figure on this list is derived from the three ledger
// tables on each read — no balance column exists, because two caches in this
// codebase have already drifted from the ledger behind them.
export default async function AgentsPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  // Paged with fetchAll: a bare select stops at 1,000 rows without a word, and
  // a ledger cut short reports an agent's balance short with it. Each read ends
  // its sort in the primary key so no row can fall between two pages.
  const [agents, comms, adjs, pays, buyers] = await Promise.all([
    fetchAll<{ id: string; name: string; phone: string | null; city: string | null; default_commission_pct: number | null; active: boolean }>(
      admin, "agents", "*", (q) => q.order("active", { ascending: false }).order("name").order("id"),
    ),
    fetchAll<{ agent_id: string; order_id: string; commission_amount: number | null }>(
      admin, "agent_commissions", "agent_id, order_id, commission_amount", (q) => q.order("id"),
    ),
    fetchAll<{ agent_id: string; order_id: string | null; delta: number | null }>(admin, "agent_adjustments", "agent_id, order_id, delta", (q) => q.order("id")),
    fetchAll<{ agent_id: string; amount: number | null; voided_at: string | null }>(admin, "agent_payments", "agent_id, amount, voided_at", (q) => q.order("id")),
    fetchAll<{ buyer_id: string; agent_id: string }>(admin, "buyer_agents", "buyer_id, agent_id", (q) => q.order("buyer_id")),
  ]);

  // One orders read for every accrual on the board, so the collected share —
  // which is what separates earned from payable — is computed from the same
  // numbers the order page shows. Read 150 ids at a time: one .in() list of
  // every id would outgrow the request URL.
  const orderIds = [...new Set([...comms.map((c) => c.order_id), ...adjs.map((a) => a.order_id).filter(Boolean)])] as string[];
  type OrderShare = { id: string; total_amount: number | null; advance_amount: number | null; credit_applied: number | null };
  const ORDER_CHUNK = 150;
  const orderChunks = await Promise.all(
    Array.from({ length: Math.ceil(orderIds.length / ORDER_CHUNK) }, (_, i) =>
      fetchAll<OrderShare>(admin, "orders", "id, total_amount, advance_amount, credit_applied", (q) =>
        q.in("id", orderIds.slice(i * ORDER_CHUNK, (i + 1) * ORDER_CHUNK)).order("id"),
      ),
    ),
  );
  const shareBy = new Map(orderChunks.flat().map((o) => [o.id, collectedShare(o)]));

  const rows: AgentRow[] = agents.map((a) => {
    const mine = comms.filter((c) => c.agent_id === a.id);
    const t = agentTotals(
      mine.map((c) => ({ commission_amount: c.commission_amount, collected: shareBy.get(c.order_id) ?? 0 })),
      adjs.filter((x) => x.agent_id === a.id).map((x) => ({ delta: x.delta, collected: x.order_id ? shareBy.get(x.order_id) ?? 0 : 1 })),
      pays.filter((p) => p.agent_id === a.id),
    );
    return {
      id: a.id,
      name: a.name,
      phone: a.phone,
      city: a.city,
      defaultPct: Number(a.default_commission_pct) || 0,
      active: a.active,
      orders: mine.length,
      buyers: buyers.filter((b) => b.agent_id === a.id).length,
      ...t,
    };
  });

  return <AgentsView rows={rows} />;
}

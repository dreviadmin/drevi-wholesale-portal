import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAgentAccount } from "@/lib/agent-ledger";
import { AgentDetail } from "./AgentDetail";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params }: { params: { id: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const [{ data: agent }, account, { data: linked }] = await Promise.all([
    admin.from("agents").select("*").eq("id", params.id).maybeSingle(),
    loadAgentAccount(params.id),
    // The link lives in buyer_agents since 0067 dropped buyers.agent_id — the
    // old read errored on the missing column, so this page never listed a
    // buyer while the agents list counted them from here.
    admin.from("buyer_agents").select("buyer_id, buyers(id, business_name)").eq("agent_id", params.id),
  ]);
  if (!agent) notFound();
  const buyers = (linked ?? [])
    .map((r) => {
      const b = (Array.isArray(r.buyers) ? r.buyers[0] : r.buyers) as { business_name: string | null } | null | undefined;
      return { id: r.buyer_id as string, name: b?.business_name ?? "—" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <AgentDetail
      agent={{
        id: agent.id, name: agent.name, phone: agent.phone, email: agent.email,
        city: agent.city, address: agent.address, notes: agent.notes,
        defaultPct: Number(agent.default_commission_pct) || 0, active: agent.active,
      }}
      totals={account.totals}
      orders={account.orders}
      payments={account.payments}
      buyers={buyers}
    />
  );
}

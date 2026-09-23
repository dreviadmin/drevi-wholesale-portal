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
    admin.from("buyers").select("id, business_name").eq("agent_id", params.id).order("business_name"),
  ]);
  if (!agent) notFound();

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
      buyers={(linked ?? []).map((b) => ({ id: b.id, name: b.business_name ?? "—" }))}
    />
  );
}

import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { BuyersTable, type BuyerRowDTO } from "./BuyersTable";
import type { Buyer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function BuyersPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const [{ data: buyers }, { data: orders }] = await Promise.all([
    admin.from("buyers").select("*").order("created_at", { ascending: false }),
    admin.from("orders").select("buyer_id, submitted_at"),
  ]);

  const stats = new Map<string, { count: number; last: string | null }>();
  for (const o of orders ?? []) {
    const s = stats.get(o.buyer_id) ?? { count: 0, last: null };
    s.count += 1;
    if (!s.last || o.submitted_at > s.last) s.last = o.submitted_at;
    stats.set(o.buyer_id, s);
  }

  const rows: BuyerRowDTO[] = ((buyers ?? []) as Buyer[]).map((b) => ({
    id: b.id,
    business_name: b.business_name,
    owner_name: b.owner_name,
    phone: b.phone,
    city: b.city,
    email: b.email,
    status: b.status,
    source: b.source,
    created_at: b.created_at,
    ordersCount: stats.get(b.id)?.count ?? 0,
    lastOrder: stats.get(b.id)?.last ?? null,
  }));

  return <BuyersTable rows={rows} />;
}

import { requireAdminOrRedirect } from "@/lib/staff";
import { AutoRefresh } from "@/components/AutoRefresh";
import { createAdminClient } from "@/lib/supabase/admin";
import { OrdersTable, type OrderRowDTO } from "./OrdersTable";
import type { Order, Buyer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const { data: orders } = await admin
    .from("orders")
    .select("id, order_number, buyer_id, total_amount, status, source, exhibition_event, submitted_at")
    .order("submitted_at", { ascending: false });

  const buyerIds = Array.from(new Set((orders ?? []).map((o) => o.buyer_id)));
  const { data: buyers } = buyerIds.length
    ? await admin.from("buyers").select("id, business_name").in("id", buyerIds)
    : { data: [] as Pick<Buyer, "id" | "business_name">[] };
  const nameById = new Map((buyers ?? []).map((b) => [b.id, b.business_name]));

  const rows: OrderRowDTO[] = ((orders ?? []) as Array<Pick<Order, "id" | "order_number" | "buyer_id" | "total_amount" | "status" | "source" | "exhibition_event" | "submitted_at">>).map((o) => ({
    id: o.id,
    order_number: o.order_number,
    business: nameById.get(o.buyer_id) ?? "—",
    total: o.total_amount,
    status: o.status,
    source: o.source,
    submitted_at: o.submitted_at,
  }));

  return (<><AutoRefresh /><OrdersTable rows={rows} /></>);
}

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
    .select("id, order_number, buyer_id, total_amount, advance_amount, status, source, exhibition_event, submitted_at, items")
    .order("submitted_at", { ascending: false });

  const buyerIds = Array.from(new Set((orders ?? []).map((o) => o.buyer_id)));
  const { data: buyers } = buyerIds.length
    ? await admin.from("buyers").select("id, business_name, phone").in("id", buyerIds)
    : { data: [] as Pick<Buyer, "id" | "business_name" | "phone">[] };
  const buyerById = new Map((buyers ?? []).map((b) => [b.id, b]));

  const rows: OrderRowDTO[] = ((orders ?? []) as Array<Pick<Order, "id" | "order_number" | "buyer_id" | "total_amount" | "advance_amount" | "status" | "source" | "exhibition_event" | "submitted_at" | "items">>).map((o) => {
    const advance = o.advance_amount ?? 0;
    return {
      id: o.id,
      order_number: o.order_number,
      business: buyerById.get(o.buyer_id)?.business_name ?? "—",
      phone: buyerById.get(o.buyer_id)?.phone ?? null,
      total: o.total_amount,
      advance,
      balance: o.status === "cancelled" ? 0 : Math.max(0, o.total_amount - advance),
      status: o.status,
      source: o.source,
      submitted_at: o.submitted_at,
      // Flattened item SKUs + titles so the search box (and tag scans) can
      // find every order containing a garment.
      itemsText: (o.items ?? []).map((it) => `${it.sku} ${it.title ?? ""}`).join(" ").toLowerCase(),
    };
  });

  return (<><AutoRefresh /><OrdersTable rows={rows} /></>);
}

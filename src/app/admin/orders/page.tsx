import Link from "next/link";
import { requireAdminOrRedirect } from "@/lib/staff";
import { AutoRefresh } from "@/components/AutoRefresh";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { OrdersTable, type OrderRowDTO } from "./OrdersTable";
import { VoidBillButton } from "../retail-bill/VoidBillButton";
import type { Order, Buyer, RetailBill } from "@/lib/types";

export const dynamic = "force-dynamic";

// Ansh (4 Sep): orders bifurcate into WHOLESALE (the order lifecycle) and
// RETAIL (walk-in MRP bills) — two streams, one address. The retail panel
// lists every bill with PDF / Edit / Void; creating one stays on
// /admin/retail-bill (Sell space).
export default async function OrdersPage({ searchParams }: { searchParams?: { stream?: string; q?: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  const stream = searchParams?.stream === "retail" ? "retail" : "wholesale";

  const tab = (key: "wholesale" | "retail", label: string) => (
    <Link
      key={key}
      href={key === "wholesale" ? "/admin/orders" : "/admin/orders?stream=retail"}
      className="font-body uppercase"
      style={{
        fontSize: 10.5, letterSpacing: "0.16em", padding: "9px 18px", fontWeight: 600,
        background: stream === key ? palette.black : "transparent",
        color: stream === key ? palette.ivory : palette.softBlack,
        border: stream === key ? "none" : "1px solid rgba(26,26,26,0.2)",
      }}
    >
      {label}
    </Link>
  );
  const tabs = (
    <div className="flex gap-1.5 px-4 md:px-8 pt-6">{tab("wholesale", "Wholesale")}{tab("retail", "Retail")}</div>
  );

  if (stream === "retail") {
    const q = (searchParams?.q ?? "").trim();
    let query = admin.from("retail_bills").select("*").order("created_at", { ascending: false }).limit(100);
    if (q) query = query.or(`bill_number.ilike.%${q}%,customer_name.ilike.%${q}%,customer_phone.ilike.%${q}%`);
    const { data: bills } = await query;
    const rows = (bills ?? []) as RetailBill[];
    const live = rows.filter((b) => !b.voided_at);
    const totalValue = live.reduce((s, b) => s + (Number(b.total) || 0), 0);

    return (
      <>
        <AutoRefresh />
        {tabs}
        <div className="px-4 md:px-8 py-5 max-w-3xl">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <form method="get" action="/admin/orders" className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px", background: "#fff" }}>
              <input type="hidden" name="stream" value="retail" />
              <input name="q" defaultValue={q} placeholder="Search bill no., customer or phone" className="font-body bg-transparent outline-none" style={{ fontSize: 12.5, minWidth: 220, color: palette.black }} />
              <button type="submit" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.goldDeep }}>Search</button>
            </form>
            <Link href="/admin/retail-bill" className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.16em", background: palette.gold, color: palette.black, padding: "10px 16px", fontWeight: 600 }}>
              + New retail bill
            </Link>
          </div>

          <div className="font-body mt-3" style={{ fontSize: 11.5, color: palette.mutedGreige }}>
            {live.length} bill{live.length === 1 ? "" : "s"} · {formatINR(totalValue)}{q ? ` · matching “${q}”` : ""}
          </div>

          <div className="mt-3" style={{ borderTop: "1px solid rgba(26,26,26,0.12)" }}>
            {rows.length === 0 && (
              <div className="font-body py-10 text-center" style={{ fontSize: 12, color: palette.mutedGreige }}>No retail bills{q ? " match." : " yet."}</div>
            )}
            {rows.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 py-2.5 flex-wrap" style={{ borderBottom: "1px solid rgba(26,26,26,0.07)", opacity: b.voided_at ? 0.5 : 1 }}>
                <div className="min-w-0">
                  <div className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>
                    {b.bill_number}
                    {b.voided_at && <span className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.12em", color: "#9C3A31", marginLeft: 8 }}>VOIDED</span>}
                  </div>
                  <div className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                    {new Date(b.bill_date + "T12:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    {" · "}{(b.items ?? []).length} item{(b.items ?? []).length === 1 ? "" : "s"}
                    {b.customer_name ? ` · ${b.customer_name}` : ""}
                    {b.customer_phone ? ` · ${b.customer_phone}` : ""}
                    {b.payment_method ? ` · ${b.payment_method}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{formatINR(b.total)}</span>
                  <a href={`/api/retail-bills/${b.id}/pdf`} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>PDF</a>
                  {!b.voided_at && (
                    <Link href={`/admin/retail-bill?edit=${b.id}`} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>Edit</Link>
                  )}
                  {!b.voided_at && <VoidBillButton billId={b.id} billNumber={b.bill_number} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

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

  return (<><AutoRefresh />{tabs}<OrdersTable rows={rows} /></>);
}

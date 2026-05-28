import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireAdminOrRedirect, isAdminRole } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { OrderActions } from "./OrderActions";
import type { Order, Buyer } from "@/lib/types";

export const dynamic = "force-dynamic";

function fmt(iso: string) { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); }

export default async function AdminOrderDetail({ params }: { params: { id: string } }) {
  const staff = await requireAdminOrRedirect();
  const admin = createAdminClient();
  const { data: order } = await admin.from("orders").select("*").eq("id", params.id).maybeSingle();
  if (!order) notFound();
  const o = order as Order;
  const { data: buyer } = await admin.from("buyers").select("business_name, owner_name, phone").eq("id", o.buyer_id).maybeSingle<Pick<Buyer, "business_name" | "owner_name" | "phone">>();

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <Link href="/admin/orders" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}>
        <ChevronLeft size={14} /> Orders
      </Link>

      <div className="mt-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>{o.order_number}</h1>
          <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>
            {[buyer?.business_name, buyer?.owner_name, buyer?.phone].filter(Boolean).join(" · ")}
          </div>
          <div className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige, letterSpacing: "0.04em" }}>
            {fmt(o.submitted_at)} · Source: {o.source === "exhibition" ? "Exhibition" : "Portal"} · Status: {o.status}
          </div>
        </div>
        {isAdminRole(staff.role) && <OrderActions orderId={o.id} status={o.status} />}
      </div>

      <div className="mt-6" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
        {(o.items ?? []).map((it, i) => (
          <div key={`${it.sku}-${i}`} className="flex items-start justify-between py-3" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
            <div>
              <div className="font-display" style={{ fontSize: 14, color: palette.black, fontWeight: 500 }}>{it.title}</div>
              <div className="font-body mt-0.5" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.1em" }}>{it.sku} · {it.stock_state}{it.restock_days ? ` · ${it.restock_days}d` : ""}</div>
            </div>
            <div className="text-right">
              <div className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>{it.qty} × {formatINR(it.unit_price)}</div>
              <div className="font-display mt-0.5" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{formatINR(it.qty * it.unit_price)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-baseline justify-between mt-4">
        <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em", color: palette.softBlack }}>Total</span>
        <span className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>{formatINR(o.total_amount)}</span>
      </div>

      {o.notes && (
        <div className="mt-5 p-3" style={{ background: palette.ivoryDeep }}>
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Buyer note</div>
          <p className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6 }}>{o.notes}</p>
        </div>
      )}
    </div>
  );
}

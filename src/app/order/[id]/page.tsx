import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { Order, OrderItem } from "@/lib/types";

export const dynamic = "force-dynamic";

function itemStateLabel(item: OrderItem): string {
  switch (item.stock_state) {
    case "ready":
      return "In Stock";
    case "limited":
      return "Limited";
    case "made_to_order":
      return `Made to Order · ${item.restock_days ?? "?"}d`;
    default:
      return "";
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default async function OrderConfirmationPage({ params }: { params: { id: string } }) {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS scopes this to the buyer's own orders (or staff).
  const { data: order } = await supabase.from("orders").select("*").eq("id", params.id).maybeSingle();
  if (!order) notFound();

  const o = order as Order;
  const items = Array.isArray(o.items) ? o.items : [];
  const maxLead = items
    .filter((i) => i.stock_state === "made_to_order")
    .reduce((m, i) => Math.max(m, i.restock_days ?? 0), 0);

  return (
    <div className="min-h-screen" style={{ background: palette.ivory }}>
      <div className="px-4 py-3.5 sticky top-0 z-10 flex items-center justify-center" style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
        <div className="font-display" style={{ fontSize: 16, letterSpacing: "0.35em", color: palette.black, fontWeight: 600 }}>DREVI</div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="text-center">
          <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.25em", color: palette.gold }}>
            Order Request Received
          </div>
          <div className="font-display mt-3" style={{ fontSize: 26, fontWeight: 600, color: palette.black }}>
            {o.order_number}
          </div>
          <div className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige, letterSpacing: "0.04em" }}>
            {fmtDate(o.submitted_at)} · {o.status.charAt(0).toUpperCase() + o.status.slice(1)}
          </div>
        </div>

        <div className="mt-8" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
          {items.map((it, idx) => (
            <div key={`${it.sku}-${idx}`} className="flex items-start justify-between py-3" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
              <div className="min-w-0 pr-3">
                <div className="font-display" style={{ fontSize: 14, color: palette.black, fontWeight: 500 }}>{it.title}</div>
                <div className="font-body mt-0.5" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.1em" }}>{it.sku}</div>
                <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.04em" }}>{itemStateLabel(it)}</div>
              </div>
              <div className="text-right flex-shrink-0">
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

        {maxLead > 0 && (
          <div className="font-body mt-1 text-right" style={{ fontSize: 11, color: palette.goldDeep, letterSpacing: "0.04em" }}>
            Estimated availability: {maxLead} days
          </div>
        )}

        {o.notes && (
          <div className="mt-6 p-3" style={{ background: palette.ivoryDeep }}>
            <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Your note</div>
            <p className="font-body mt-1" style={{ fontSize: 12, color: palette.softBlack, lineHeight: 1.6 }}>{o.notes}</p>
          </div>
        )}

        <div className="mt-8 p-4" style={{ background: palette.ivoryDeep }}>
          <p className="font-body" style={{ fontSize: 12, color: palette.softBlack, lineHeight: 1.7 }}>
            Thank you. Rakesh will confirm availability and pricing, and arrange billing offline. A confirmation
            summary will follow shortly.
          </p>
          <p className="font-body mt-2" style={{ fontSize: 10, color: palette.mutedGreige, letterSpacing: "0.04em" }}>
            PDF confirmation &amp; WhatsApp delivery arrive in Phase 4.
          </p>
        </div>

        <div className="flex gap-3 mt-8 justify-center">
          <Link href="/catalog" className="font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.2em", padding: "11px 18px" }}>
            Continue Browsing
          </Link>
          <Link href="/account/orders" className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.2em", padding: "11px 18px" }}>
            My Orders
          </Link>
        </div>
      </div>
    </div>
  );
}

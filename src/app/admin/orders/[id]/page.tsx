import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ZoomImage } from "@/components/Lightbox";
import { requireAdminOrRedirect, isAdminRole } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatINR, formatUnitINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { OrderActions } from "./OrderActions";
import { OrderEditor, type PickerProduct } from "./OrderEditor";
import type { Order, Buyer } from "@/lib/types";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = { portal_self_service: "Portal", exhibition: "Exhibition", in_store: "In-store" };

function fmt(iso: string) { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); }

export default async function AdminOrderDetail({ params }: { params: { id: string } }) {
  const staff = await requireAdminOrRedirect();
  const admin = createAdminClient();
  const { data: order } = await admin.from("orders").select("*").eq("id", params.id).maybeSingle();
  if (!order) notFound();
  const o = order as Order;
  const { data: buyer } = await admin.from("buyers").select("business_name, owner_name, phone").eq("id", o.buyer_id).maybeSingle<Pick<Buyer, "business_name" | "owner_name" | "phone">>();

  // Catalog for the "add item" picker in the order editor (admins only).
  let pickerProducts: PickerProduct[] = [];
  if (isAdminRole(staff.role) && (o.status === "submitted" || o.status === "confirmed")) {
    const { data: prods } = await admin
      .from("wholesale_products")
      .select("sku, title, wholesale_price, image_urls")
      .eq("wholesale_visible", true)
      .order("title", { nullsFirst: false });
    pickerProducts = (prods ?? []).map((p) => ({
      sku: p.sku,
      title: p.title,
      wholesale_price: p.wholesale_price,
      image_url: (p.image_urls as string[] | null)?.[0] ?? null,
    }));
  }

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
            {fmt(o.submitted_at)} · Source: {SOURCE_LABEL[o.source] ?? o.source} · Status: {o.status}
          </div>
        </div>
        {isAdminRole(staff.role) && (
          <div className="flex flex-col items-end gap-2">
            <OrderActions orderId={o.id} status={o.status} pdfUrl={o.pdf_url} orderNumber={o.order_number} total={o.total_amount} buyerPhone={buyer?.phone ?? null} />
            <OrderEditor
              orderId={o.id}
              status={o.status}
              items={o.items ?? []}
              products={pickerProducts}
              discountType={o.discount_type}
              discountValue={o.discount_value}
              taxMode={o.tax_mode}
              taxRate={o.tax_rate}
              advanceAmount={o.advance_amount}
              paymentMethod={o.payment_method}
              paymentNotes={o.payment_notes}
            />
          </div>
        )}
      </div>

      <div className="mt-6" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
        {(o.items ?? []).map((it, i) => (
          <div key={`${it.sku}-${i}`} className="flex items-start gap-3 py-3" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
            {it.image_url ? (
              <ZoomImage src={it.image_url} alt={it.title} width={56} height={70} />
            ) : (
              <div className="relative flex-shrink-0" style={{ width: 56, height: 70, background: palette.ivoryDeep }} />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-display" style={{ fontSize: 14, color: palette.black, fontWeight: 500 }}>{it.title}</div>
              <div className="font-body mt-0.5" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.1em" }}>
                {it.custom ? "custom item · not on portal" : `${it.sku} · ${it.stock_state}${it.restock_days ? ` · ${it.restock_days}d` : ""}`}{it.special_request ? " · SPECIAL QTY REQUEST" : ""}
              </div>
              {it.actual_qty != null && (
                <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep, fontWeight: 600 }}>
                  GST split — actual: {it.actual_qty} pc @ {formatINR((it.qty * it.unit_price) / it.actual_qty)} (billed as {it.qty} × {formatUnitINR(it.unit_price)})
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>{it.qty} × {formatUnitINR(it.unit_price)}</div>
              <div className="font-display mt-0.5" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{formatINR(it.qty * it.unit_price)}</div>
            </div>
          </div>
        ))}
      </div>

      {(o.discount_amount ?? 0) > 0 && (
        <div className="flex items-baseline justify-between mt-4 font-body" style={{ fontSize: 12, color: palette.goldDeep }}>
          <span>Discount{o.discount_type === "percent" ? ` (${o.discount_value}%)` : ""}</span><span>− {formatINR(o.discount_amount)}</span>
        </div>
      )}
      {o.tax_mode === "exclusive" && (
        <div className="flex items-baseline justify-between mt-2 font-body" style={{ fontSize: 12, color: palette.softBlack }}>
          <span>GST @ {o.tax_rate}% (added)</span><span>{formatINR(o.tax_amount)}</span>
        </div>
      )}
      <div className="flex items-baseline justify-between mt-2">
        <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em", color: palette.softBlack }}>Total</span>
        <span className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>{formatINR(o.total_amount)}</span>
      </div>
      {o.tax_mode === "inclusive" && (
        <div className="font-body text-right mt-1" style={{ fontSize: 10, color: palette.mutedGreige }}>includes GST @ {o.tax_rate}% = {formatINR(o.tax_amount)}</div>
      )}
      {(o.advance_amount ?? 0) > 0 && (
        <div className="mt-3 p-3" style={{ background: palette.ivoryDeep }}>
          <div className="flex justify-between font-body" style={{ fontSize: 12, color: palette.softBlack }}>
            <span>Advance received{o.payment_method ? ` (${o.payment_method})` : ""}</span><span>{formatINR(o.advance_amount)}</span>
          </div>
          <div className="flex justify-between font-body mt-1" style={{ fontSize: 13, color: palette.goldDeep, fontWeight: 600 }}>
            <span>Balance due</span><span>{formatINR(Math.max(0, o.total_amount - o.advance_amount))}</span>
          </div>
          {o.payment_notes && <div className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige }}>{o.payment_notes}</div>}
        </div>
      )}

      {o.notes && (
        <div className="mt-5 p-3" style={{ background: palette.ivoryDeep }}>
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Buyer note</div>
          <p className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6 }}>{o.notes}</p>
        </div>
      )}
    </div>
  );
}

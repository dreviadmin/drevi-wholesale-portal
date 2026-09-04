import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffOrRedirect } from "@/lib/staff";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { RetailBillForm } from "./RetailBillForm";
import { VoidBillButton } from "./VoidBillButton";
import type { RetailBill } from "@/lib/types";

export const dynamic = "force-dynamic";

// Retail billing (Ansh, 31 Aug) — sell at the retail price (Final MRP) to
// walk-in customers. Every sheet row is billable, including garments hidden
// from the wholesale portal (they still hang in the shop, same rule as the
// retail price check). Past-dated bills carry the chosen day in their number.
export default async function RetailBillPage({ searchParams }: { searchParams?: { edit?: string } }) {
  await requireStaffOrRedirect();
  const admin = createAdminClient();
  // Edit mode (Ansh, 4 Sep): ?edit=<id> loads a bill into the form — lines,
  // terms and customer prefilled; saving applies stock deltas.
  let editBill: RetailBill | null = null;
  if (searchParams?.edit && /^[0-9a-f-]{36}$/i.test(searchParams.edit)) {
    const { data } = await admin.from("retail_bills").select("*").eq("id", searchParams.edit).maybeSingle();
    if (data && !data.voided_at) editBill = data as RetailBill;
  }
  const [{ data: products }, { data: retail }, { data: bills }] = await Promise.all([
    admin
      .from("wholesale_products")
      .select("sku, title, category, color, current_qty, image_urls")
      .order("title", { nullsFirst: false }),
    admin.from("product_vendor_info").select("sku, retail_price"),
    admin.from("retail_bills").select("*").order("created_at", { ascending: false }).limit(15),
  ]);
  const retailBySku = new Map((retail ?? []).map((r) => [String(r.sku).toUpperCase(), Number(r.retail_price) || 0]));
  const catalog = (products ?? []).map((p) => ({
    sku: p.sku as string,
    title: (p.title as string | null) ?? p.sku,
    category: (p.category as string | null) ?? null,
    color: (p.color as string | null) ?? null,
    stock: Number(p.current_qty) || 0,
    image: (p.image_urls as string[] | null)?.[0] ?? null,
    retailPrice: retailBySku.get(String(p.sku).toUpperCase()) ?? 0,
  }));

  const recent = (bills ?? []) as RetailBill[];

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Retail billing</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, lineHeight: 1.6, color: palette.softBlack }}>
        Bill a walk-in customer at the <b>retail price</b>. Scan tags or search, adjust if negotiated,
        pick a bill date (past dates allowed), save — the bill PDF is ready to share and stock updates immediately.
      </p>

      <RetailBillForm key={editBill?.id ?? "new"} catalog={catalog} editBill={editBill} />

      {recent.length > 0 && (
        <div className="mt-8">
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Recent retail bills</div>
          {recent.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-2 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)", opacity: b.voided_at ? 0.5 : 1 }}>
              <div className="min-w-0">
                <div className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>
                  {b.bill_number}
                  {b.voided_at && <span className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.12em", color: "#9C3A31", marginLeft: 8 }}>VOIDED</span>}
                </div>
                <div className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                  {new Date(b.bill_date + "T12:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                  {" · "}{(b.items ?? []).length} item{(b.items ?? []).length === 1 ? "" : "s"}
                  {b.customer_name ? ` · ${b.customer_name}` : ""}
                  {b.payment_method ? ` · ${b.payment_method}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{formatINR(b.total)}</span>
                <a href={`/api/retail-bills/${b.id}/pdf`} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>PDF</a>
                {!b.voided_at && (
                  <a href={`/admin/retail-bill?edit=${b.id}`} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>Edit</a>
                )}
                {!b.voided_at && <VoidBillButton billId={b.id} billNumber={b.bill_number} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

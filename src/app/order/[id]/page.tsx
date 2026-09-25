import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { SignOutButton } from "@/components/SignOutButton";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ORDER_STATUS_LABEL } from "@/lib/order-status";
import { formatINR, formatUnitINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { effectiveLineState } from "@/lib/order-lines-core";
import { returnedByBillLine, type CreditNoteLike } from "@/lib/credit-core";
import type { Order, OrderBill, OrderItem } from "@/lib/types";

/** Only what this page shows of a credit note — the note itself is staff-side. */
type BuyerCreditNote = CreditNoteLike & { note_number: string };

export const dynamic = "force-dynamic";

function itemStateLabel(item: OrderItem): string {
  switch (item.stock_state) {
    case "ready":
      return "In Stock";
    case "limited":
      return "Limited";
    case "made_to_order":
      return item.restock_days ? `Made to Order · ${item.restock_days}d` : "Made to Order";
    default:
      return "";
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
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
  // Bills (18 Aug): RLS proved ownership on the order read above; the bills
  // themselves are fetched with the admin client (order_bills has no buyer
  // policies) — scoped strictly to this order's id. Credit notes (11 Sep) are
  // read the same way for the same reason, so a returned line does not keep
  // reading as plainly billed on the buyer's own page.
  const admin = createAdminClient();
  const [{ data: billRows }, { data: noteRows }] = await Promise.all([
    admin.from("order_bills").select("*").eq("order_id", o.id).order("seq"),
    admin
      .from("credit_notes")
      .select("id, note_number, status, order_bill_id, items")
      .eq("order_id", o.id)
      .eq("status", "issued")
      .order("created_at"),
  ]);
  const bills = (billRows ?? []) as OrderBill[];
  const creditNotes = (noteRows ?? []) as BuyerCreditNote[];
  const creditApplied = Number((order as Record<string, unknown>).credit_applied ?? 0) || 0;
  const returnedQtyByBillLine = returnedByBillLine(creditNotes);

  // The bill snapshot is the stable address for a return (orders.items is
  // re-packed by Modify Order), so resolve each order line to its bill line —
  // same order, sku-checked — before reading the returned quantity off it.
  const billLineOf = new Map<number, { bill: OrderBill; billIndex: number }>();
  const noteNumbersOf = new Map<string, string[]>();
  for (const b of bills) {
    let k = 0;
    items.forEach((it, i) => {
      if (it.billed_in !== b.id) return;
      const snap = (b.items ?? [])[k];
      if (snap && snap.sku === it.sku) billLineOf.set(i, { bill: b, billIndex: k });
      k += 1;
    });
  }
  for (const n of creditNotes) {
    if (!n.order_bill_id) continue;
    for (const line of n.items ?? []) {
      if (line?.bill_line_index == null) continue;
      const key = `${n.order_bill_id}:${line.bill_line_index}`;
      const list = noteNumbersOf.get(key) ?? [];
      if (!list.includes(n.note_number)) list.push(n.note_number);
      noteNumbersOf.set(key, list);
    }
  }
  const maxLead = items
    .filter((i) => i.stock_state === "made_to_order")
    .reduce((m, i) => Math.max(m, i.restock_days ?? 0), 0);

  // Older orders predate image snapshots — backfill thumbs by SKU.
  const missingImg = items.filter((i) => !i.image_url).map((i) => i.sku);
  const imgBySku = new Map<string, string>();
  if (missingImg.length > 0) {
    const { data: prods } = await admin.from("wholesale_products").select("sku, image_urls").in("sku", missingImg);
    for (const p of prods ?? []) {
      const first = Array.isArray(p.image_urls) ? (p.image_urls as string[])[0] : undefined;
      if (first) imgBySku.set(p.sku, first);
    }
  }

  return (
    <div className="min-h-screen" style={{ background: palette.ivory }}>
      {/* The left slot was an 18px spacer balancing an 18px icon. The sign-out
          control carries words now, so both flanks grow instead — the wordmark
          stays centred rather than drifting a thumb's width to the left. */}
      <div className="px-4 py-3.5 sticky top-0 z-10 flex items-center" style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
        <span className="flex-1" />
        <div className="font-display whitespace-nowrap" style={{ fontSize: 16, letterSpacing: "0.35em", color: palette.black, fontWeight: 600 }}>DREVI</div>
        <div className="flex-1 flex justify-end">
          <SignOutButton />
        </div>
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
            {fmtDate(o.submitted_at)} · {ORDER_STATUS_LABEL[o.status] ?? o.status}
          </div>
        </div>

        <div className="mt-8" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
          {items.map((it, idx) => {
            const img = it.image_url ?? imgBySku.get(it.sku) ?? null;
            return (
              <div key={`${it.sku}-${idx}`} className="flex items-start gap-3 py-3" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <div className="relative flex-shrink-0" style={{ width: 56, height: 70, background: palette.ivoryDeep }}>
                  {img && <Image src={img} alt={it.title} fill sizes="56px" className="object-cover" />}
                </div>
                <div className="min-w-0 flex-1 pr-3">
                  <div className="font-display" style={{ fontSize: 14, color: palette.black, fontWeight: 500 }}>{it.title}</div>
                  <div className="font-body mt-0.5" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.1em" }}>{it.sku}</div>
                  <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.04em" }}>
                    {itemStateLabel(it)}{it.special_request ? " · Special qty request" : ""}
                  </div>
                  {/* Line-level confirmation (18 Aug): the customer sees where
                      each piece stands — billed, confirmed, or on hold with
                      Rakesh's availability note. */}
                  {(() => {
                    const st = effectiveLineState(it, o.status);
                    if (st === "billed") return <div className="font-body mt-1" style={{ fontSize: 10, color: "#1F6B45", fontWeight: 600 }}>Billed ✓</div>;
                    if (st === "confirmed") return <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep, fontWeight: 600 }}>Confirmed — billing shortly</div>;
                    if (st === "hold") return (
                      <div className="font-body mt-1" style={{ fontSize: 10.5, color: "#9C3A31" }}>
                        Awaiting availability{it.hold_note ? ` — ${it.hold_note}` : ""}
                      </div>
                    );
                    return null;
                  })()}
                  {/* A line that came back must not keep reading as plainly
                      billed — the credit note is the buyer's own receipt for it. */}
                  {(() => {
                    const m = billLineOf.get(idx);
                    if (!m) return null;
                    const key = `${m.bill.id}:${m.billIndex}`;
                    const back = returnedQtyByBillLine.get(key) ?? 0;
                    if (back <= 0) return null;
                    const billedQty = Number(m.bill.items[m.billIndex]?.qty) || 0;
                    const nums = noteNumbersOf.get(key) ?? [];
                    return (
                      <div className="font-body mt-1" style={{ fontSize: 10.5, color: palette.crimsonText }}>
                        Returned {back}{billedQty ? ` of ${billedQty}` : ""}
                        {nums.length ? ` · credit note ${nums.join(", ")}` : ""}
                      </div>
                    );
                  })()}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>{it.qty} × {formatUnitINR(it.unit_price)}</div>
                  <div className="font-display mt-0.5" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{formatINR(it.qty * it.unit_price)}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Money breakdown — without these rows a staff-billed order's items
            didn't sum to the printed Total on the buyer's own page (audit fix). */}
        {(o.discount_amount ?? 0) > 0 && (
          <div className="flex items-baseline justify-between mt-4 font-body" style={{ fontSize: 12, color: palette.goldDeep }}>
            <span>Discount{o.discount_type === "percent" ? ` (${o.discount_value}%)` : ""}</span>
            <span>− {formatINR(o.discount_amount)}</span>
          </div>
        )}
        {o.tax_mode === "exclusive" && (
          <div className="flex items-baseline justify-between mt-2 font-body" style={{ fontSize: 12, color: palette.softBlack }}>
            <span>GST @ {o.tax_rate}%</span>
            <span>{formatINR(o.tax_amount)}</span>
          </div>
        )}
        <div className="flex items-baseline justify-between mt-4">
          <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em", color: palette.softBlack }}>Total</span>
          <span className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>{formatINR(o.total_amount)}</span>
        </div>
        {o.tax_mode === "inclusive" && (
          <div className="font-body text-right mt-1" style={{ fontSize: 10, color: palette.mutedGreige }}>includes GST @ {o.tax_rate}% = {formatINR(o.tax_amount)}</div>
        )}
        {/* Credit settles the order like an advance does, so this block mounts
            for credit alone too — otherwise an order paid partly from the
            buyer's own credit note showed the full balance. */}
        {((o.advance_amount ?? 0) > 0 || creditApplied > 0) && (
          <div className="mt-3 p-3" style={{ background: palette.ivoryDeep }}>
            {(o.advance_amount ?? 0) > 0 && (
              <div className="flex justify-between font-body" style={{ fontSize: 12, color: palette.softBlack }}>
                <span>Advance paid{o.payment_method ? ` (${o.payment_method})` : ""}</span>
                <span>{formatINR(o.advance_amount)}</span>
              </div>
            )}
            {creditApplied > 0 && (
              <div className="flex justify-between font-body mt-1" style={{ fontSize: 12, color: palette.softBlack }}>
                <span>Credit applied</span>
                <span>− {formatINR(creditApplied)}</span>
              </div>
            )}
            <div className="flex justify-between font-body mt-1" style={{ fontSize: 13, color: palette.goldDeep, fontWeight: 600 }}>
              <span>Balance due</span>
              <span>{formatINR(Math.max(0, o.total_amount - (o.advance_amount ?? 0) - creditApplied))}</span>
            </div>
          </div>
        )}

        {maxLead > 0 && (
          <div className="font-body mt-1 text-right" style={{ fontSize: 11, color: palette.goldDeep, letterSpacing: "0.04em" }}>
            Estimated availability: {maxLead} days
          </div>
        )}

        {bills.length > 0 && (
          <div className="mt-6">
            <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Bills for this order</div>
            {bills.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
                <div>
                  <div className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>{b.bill_number}</div>
                  <div className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                    {fmtDate(b.bill_date + "T12:00:00+05:30")} · {(b.items ?? []).length} item{(b.items ?? []).length === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{formatINR(b.total)}</span>
                  {b.pdf_url && (
                    <a href={b.pdf_url} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>PDF</a>
                  )}
                </div>
              </div>
            ))}
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
        </div>

        <div className="flex gap-3 mt-8 justify-center flex-wrap">
          <a
            href={`/api/orders/${o.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="font-body uppercase"
            style={{ background: palette.gold, color: palette.black, fontSize: 10, letterSpacing: "0.2em", padding: "11px 18px" }}
          >
            Download PDF
          </a>
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

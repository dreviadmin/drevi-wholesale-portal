import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { SignOutButton } from "@/components/SignOutButton";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentCatalogImages, lineImage } from "@/lib/catalog-images";
import { buyerBillLink } from "@/lib/invoice-link";
import { ORDER_STATUS_HEADING, ORDER_STATUS_LABEL, orderTimeline } from "@/lib/order-status";
import { formatINR, formatUnitINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { effectiveLineState } from "@/lib/order-lines-core";
import { returnedByBillLine, type CreditNoteLike } from "@/lib/credit-core";
import type { Order, OrderBill, OrderItem } from "@/lib/types";
import { CopyButton } from "./CopyButton";

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
  // A bill's PDF opens through its permanent /i/<bill id> link
  // (src/lib/invoice-link.ts), the same one staff send on WhatsApp: it signs a
  // fresh storage link on every open, so it keeps working however old the bill
  // is. The pdf_url saved on the row is a 30-day link, so a buyer opening an
  // invoice from here a month after billing got an expired-token error. A
  // cancelled bill gets no link at all (it is shown struck through below, the
  // way the admin page shows it).
  const billLinks = new Map(bills.map((b) => [b.id, buyerBillLink(b)]));

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

  // Each catalog line shows the catalog's CURRENT photo (7 Oct), which also
  // covers older orders that predate image snapshots.
  const currentImg = await currentCatalogImages(items.filter((i) => !i.custom).map((i) => i.sku));

  // Where the order stands, from the stage stamps staff set as it moves. A
  // lone "Submitted" step is the date line under the number already, so the
  // trail shows once there is a second step. Courier and AWB are the buyer's
  // own columns (RLS); the internal tracking note and sheet photo are not.
  const steps = orderTimeline(o);
  const hasTracking = !!(o.courier || o.tracking_number);

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
          <div className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.25em", color: o.status === "cancelled" ? palette.crimsonText : palette.gold }}>
            {ORDER_STATUS_HEADING[o.status] ?? ORDER_STATUS_LABEL[o.status] ?? o.status}
          </div>
          <div className="font-display mt-3" style={{ fontSize: 26, fontWeight: 600, color: palette.black }}>
            {o.order_number}
          </div>
          <div className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige, letterSpacing: "0.04em" }}>
            {fmtDate(o.submitted_at)} · {ORDER_STATUS_LABEL[o.status] ?? o.status}
          </div>
        </div>

        {(steps.length > 1 || hasTracking) && (
          <div className="mt-6 p-4" style={{ background: palette.ivoryDeep }}>
            {steps.length > 1 && (
              <ol aria-label="Order progress">
                {steps.map((s, i) => {
                  const last = i === steps.length - 1;
                  return (
                    <li key={s.status} className="flex gap-3">
                      <div className="flex flex-col items-center flex-shrink-0" style={{ width: 9 }}>
                        <span aria-hidden style={{ width: 9, height: 9, borderRadius: 9, marginTop: 5, background: last ? palette.gold : palette.goldDeep }} />
                        {!last && <span aria-hidden className="flex-1" style={{ width: 1, background: palette.goldDeep, opacity: 0.45 }} />}
                      </div>
                      <div className="flex-1 flex items-baseline justify-between gap-3 font-body" style={{ fontSize: 13, lineHeight: 1.5, paddingBottom: last ? 0 : 10 }}>
                        <span style={{ color: palette.black, fontWeight: last ? 600 : 400 }}>{s.label}</span>
                        <span style={{ color: palette.mutedGreige }}>{fmtDate(s.at)}</span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            {hasTracking && (
              <div
                className={steps.length > 1 ? "mt-3 pt-3" : ""}
                style={steps.length > 1 ? { borderTop: "1px solid rgba(26,26,26,0.1)" } : undefined}
              >
                <div className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em", color: palette.mutedGreige }}>
                  {o.courier && o.tracking_number ? "Courier · tracking number" : o.courier ? "Courier" : "Tracking number"}
                </div>
                <div className="flex items-center justify-between gap-3 mt-1">
                  <div className="font-body min-w-0" style={{ fontSize: 13, color: palette.black, wordBreak: "break-all" }}>
                    {o.courier}
                    {o.courier && o.tracking_number ? " · " : ""}
                    {o.tracking_number && (
                      <span id="order-awb" style={{ fontWeight: 600 }}>{o.tracking_number}</span>
                    )}
                  </div>
                  {o.tracking_number && <CopyButton value={o.tracking_number} label="tracking number" selectId="order-awb" />}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-8" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
          {items.map((it, idx) => {
            const img = lineImage(it, currentImg);
            return (
              <div key={`${it.sku}-${idx}`} className="flex items-start gap-3 py-3" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <div className="relative flex-shrink-0" style={{ width: 56, height: 100, background: palette.ivoryDeep }}>
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
                  {/* cancelBill keeps the row and frees its lines for a new
                      bill, so after a cancel-and-rebill both rows are here.
                      Unmarked, the buyer read two live invoices for one order. */}
                  {b.cancelled_at && (
                    <span className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.1em", padding: "3px 7px", background: palette.crimsonSoft, color: palette.crimsonText, fontWeight: 600 }}>Cancelled</span>
                  )}
                  <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black, textDecoration: b.cancelled_at ? "line-through" : "none" }}>{formatINR(b.total)}</span>
                  {billLinks.get(b.id) && (
                    <a href={billLinks.get(b.id) ?? undefined} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>PDF</a>
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

        {/* Only while the request waits on Rakesh — a delivered or cancelled
            order still promised a confirmation that had come and gone. */}
        {o.status === "submitted" && (
          <div className="mt-8 p-4" style={{ background: palette.ivoryDeep }}>
            <p className="font-body" style={{ fontSize: 13, color: palette.softBlack, lineHeight: 1.7 }}>
              Thank you. Rakesh will confirm availability and pricing, and arrange billing offline. A confirmation
              summary will follow shortly.
            </p>
          </div>
        )}

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

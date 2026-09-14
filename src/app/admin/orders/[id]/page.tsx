import { notFound } from "next/navigation";
import { Undo2 } from "lucide-react";
import { BackLink } from "@/components/BackLink";
import { ZoomImage } from "@/components/Lightbox";
import { requireAdminOrRedirect, isAdminRole } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatINR, formatUnitINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { NotesPanel } from "@/components/admin/NotesPanel";
import { listEntityNotes } from "@/lib/entity-notes";
import { OrderActions } from "./OrderActions";
import { EditBuyerButton } from "./EditBuyerButton";
import { RecaptureParty } from "./RecaptureParty";
import { DateCorrection } from "./DateCorrection";
import { LineHsnEditor } from "./LineHsnEditor";
import { listKnownHsnCodes } from "@/lib/hsn";
import { OrderEditor, type PickerProduct } from "./OrderEditor";
import { LineStateControls, GenerateBillBar } from "./LineBilling";
import { ReturnPanel, ApplyCreditBar, type ReturnPanelLine } from "./ReturnPanel";
import { effectiveLineState, billableLines, computeBillTotals } from "@/lib/order-lines-core";
import { loadOrderCredit, loadBuyerWallet } from "@/lib/credit-load";
import { resolveDocumentParty } from "@/lib/buyer-snapshot";
import type { Order, OrderBill } from "@/lib/types";
import { productionMoqFlag, supplyAge, type SupplyInput } from "@/lib/availability";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = { portal_self_service: "Portal", exhibition: "Exhibition", in_store: "In-store" };

function fmt(iso: string) { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); }

// The IST day a document belongs to — what the date controls edit, and what
// every report buckets on. Never UTC's day.
function istDay(iso: string) { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }

export default async function AdminOrderDetail({ params }: { params: { id: string } }) {
  const staff = await requireAdminOrRedirect();
  const admin = createAdminClient();
  const hsnOptions = await listKnownHsnCodes();
  const { data: order } = await admin.from("orders").select("*").eq("id", params.id).maybeSingle();
  if (!order) notFound();
  const o = order as Order;
  const [{ data: buyer }, { data: takenBy }, { data: billRows }, credit, wallet, printedParty] = await Promise.all([
    admin.from("buyers").select("business_name, owner_name, phone, city, gstin, address, transport_details, broker_details").eq("id", o.buyer_id).maybeSingle(),
    o.assisted_by
      ? admin.from("staff_users").select("name, email").eq("id", o.assisted_by).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("order_bills").select("*").eq("order_id", o.id).order("seq"),
    loadOrderCredit(o.id),
    loadBuyerWallet(o.buyer_id),
    // What this order's documents PRINT today (0047) — the buyers row above is
    // only what they would print after a correction. Never the same read.
    resolveDocumentParty(admin, o, o.buyer_id),
  ]);
  const bills = (billRows ?? []) as OrderBill[];
  const billNumberById = new Map(bills.map((b) => [b.id, b.bill_number]));
  // Two different questions, and conflating them WAS the bug. Line editing
  // stops at a terminal status (setLineState refuses those server-side), but
  // billing does not belong to the logistics lifecycle at all: returns are
  // raised against a bill, so an order that can never be billed can never be
  // returned either — and goods come back precisely after delivery. Billing
  // follows generateOrderBill's own rule, which refuses cancelled and nothing
  // else.
  const lineEditLocked = ["cancelled", "delivered", "fulfilled"].includes(o.status);
  const billingLocked = o.status === "cancelled";
  // Maintained by the apply/unapply RPCs (0046) as a read cache of the
  // consumption rows, so every balance-due surface can subtract it without a join.
  const creditApplied = Number((order as Record<string, unknown>).credit_applied ?? 0) || 0;
  const balanceDue = Math.max(0, o.total_amount - (o.advance_amount ?? 0) - creditApplied);

  // Returns anchor to the BILL snapshot: order_bills.items is immutable, while
  // a position in orders.items is not (Modify Order re-packs that array).
  // generateOrderBill freezes billableLines in order, so the k-th line of a
  // bill is the k-th order line billed into it; the sku must still agree or
  // the pair is dropped and the line simply shows no return badge.
  const billLineOf = new Map<number, { bill: OrderBill; billIndex: number }>();
  const orderLineOfBillLine = new Map<string, number>();
  for (const b of bills) {
    let k = 0;
    (o.items ?? []).forEach((it, i) => {
      if (it.billed_in !== b.id) return;
      const snap = (b.items ?? [])[k];
      if (snap && snap.sku === it.sku) {
        billLineOf.set(i, { bill: b, billIndex: k });
        orderLineOfBillLine.set(`${b.id}:${k}`, i);
      }
      k += 1;
    });
  }
  const returnedOf = (billId: string, billIndex: number) => credit.returnedByBillLine.get(`${billId}:${billIndex}`) ?? 0;
  const returnLinesFor = (b: OrderBill): ReturnPanelLine[] =>
    (b.items ?? []).map((item, index) => ({
      item,
      index,
      returned: returnedOf(b.id, index),
      orderLineIndex: orderLineOfBillLine.get(`${b.id}:${index}`) ?? null,
    }));
  const sourceBillOf = (b: OrderBill) => ({
    subtotal: Number(b.subtotal) || 0,
    discount_amount: Number(b.discount_amount) || 0,
    tax_mode: b.tax_mode ?? null,
    tax_rate: b.tax_rate == null ? null : Number(b.tax_rate),
  });
  // A return is raised against a BILL, so "can anything still come back" is a
  // per-bill question — and it is the one the order-level entry point answers.
  const returnableBills = bills
    .map((b) => ({
      bill: b,
      remaining: (b.items ?? []).reduce((s, it, k) => s + Math.max(0, (Number(it.qty) || 0) - returnedOf(b.id, k)), 0),
    }))
    .filter((r) => r.remaining > 0);
  const billedPieces = bills.reduce((s, b) => s + (b.items ?? []).reduce((t, it) => t + (Number(it.qty) || 0), 0), 0);
  const returnedPieces = bills.reduce((s, b) => s + (b.items ?? []).reduce((t, _it, k) => t + returnedOf(b.id, k), 0), 0);

  // Date corrections (14 Sep). A bill may not predate its order, and an order
  // may not start after the first bill raised against it — the same two bounds
  // the actions enforce, shown to the picker so it never offers a refusal.
  const orderDay = istDay(o.submitted_at);
  const earliestBillDate = bills.reduce<string | null>((min, b) => (min == null || b.bill_date < min ? b.bill_date : min), null);

  const billable = billableLines(o);
  const billableTotals = computeBillTotals(billable.map((b) => b.item), o, {
    discountApplied: bills.reduce((s, b) => s + (Number(b.discount_amount) || 0), 0),
    advanceApplied: bills.reduce((s, b) => s + (Number(b.advance_applied) || 0), 0),
  });

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

  // R7 §9.3 — production-MOQ flags. Admin only, decision support only: it
  // never blocks confirmation, and none of this reaches the buyer's copy.
  const lineSkus = (o.items ?? []).map((it) => it.sku).filter(Boolean);
  const moqFlags = new Map<string, { message: string; age: string | null }>();
  if (lineSkus.length) {
    const bases = [...new Set(lineSkus.map((sku) => sku.split("-").slice(0, 4).join("-")))];
    const [{ data: designs }, { data: stockRows }] = await Promise.all([
      admin
        .from("designs")
        .select("base_sku, color, supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_updated_at")
        .in("base_sku", bases),
      admin.from("wholesale_products").select("sku, current_qty").in("sku", lineSkus),
    ]);
    const stockBySku = new Map((stockRows ?? []).map((r) => [r.sku, Number(r.current_qty) || 0]));
    const supplyByKey = new Map<string, SupplyInput>(
      (designs ?? []).map((d) => [
        `${d.base_sku}|${String(d.color).toUpperCase()}`,
        {
          supplyMode: d.supply_mode ?? "",
          vendorStockQty: d.vendor_stock_qty ?? null,
          makingDays: d.making_days ?? null,
          deliveryDays: d.delivery_days ?? null,
          makingMoq: d.making_moq ?? null,
          supplyUpdatedAt: d.supply_updated_at ?? null,
        },
      ]),
    );
    for (const it of o.items ?? []) {
      if (!it.sku) continue;
      const parts = it.sku.split("-");
      if (parts.length < 6) continue;
      const supply = supplyByKey.get(`${parts.slice(0, 4).join("-")}|${parts[parts.length - 1].toUpperCase()}`);
      if (!supply) continue;
      const flag = productionMoqFlag({ ourStock: stockBySku.get(it.sku) ?? 0, qty: it.qty, supply });
      if (flag) moqFlags.set(it.sku, { message: flag.message, age: supplyAge(supply.supplyUpdatedAt)?.label ?? null });
    }
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <BackLink fallback="/admin/orders" fallbackLabel="Orders" />

      <div className="mt-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>{o.order_number}</h1>
          <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>
            {[buyer?.business_name, buyer?.owner_name, buyer?.phone].filter(Boolean).join(" · ")}{" "}
            {buyer && (
              <EditBuyerButton
                buyerId={o.buyer_id}
                initial={{
                  business_name: buyer.business_name ?? "",
                  owner_name: buyer.owner_name ?? "",
                  phone: buyer.phone ?? "",
                  city: buyer.city ?? "",
                  gstin: buyer.gstin ?? "",
                  address: buyer.address ?? "",
                  transport_details: buyer.transport_details ?? "",
                  broker_details: buyer.broker_details ?? "",
                }}
              />
            )}
            {/* Editing the buyer no longer reaches an issued document — the
                party is frozen on it (0047). This is the only way back from a
                party recorded wrong, so it sits next to Edit and looks nothing
                like it. */}
            {buyer && isAdminRole(staff.role) && (
              <>
                {" "}
                <RecaptureParty
                  orderId={o.id}
                  orderNumber={o.order_number}
                  billCount={bills.length}
                  creditNoteCount={credit.notes.length}
                  printed={printedParty}
                  current={{
                    business_name: buyer.business_name ?? null,
                    owner_name: buyer.owner_name ?? null,
                    phone: buyer.phone ?? null,
                    city: buyer.city ?? null,
                    gstin: buyer.gstin ?? null,
                    address: buyer.address ?? null,
                  }}
                />
              </>
            )}
          </div>
          <div className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige, letterSpacing: "0.04em" }}>
            {fmt(o.submitted_at)}
            {/* Sits on the date it corrects, next to Edit and Correct party —
                a back-dated entry typed wrong has had no way back until now. */}
            {isAdminRole(staff.role) && o.status !== "cancelled" && (
              <>
                {" "}
                <DateCorrection
                  kind="order"
                  targetId={o.id}
                  documentNumber={o.order_number}
                  currentDate={orderDay}
                  ceilingDate={earliestBillDate}
                />
              </>
            )}
            {" · "}Source: {SOURCE_LABEL[o.source] ?? o.source} · Status: {o.status.replace(/_/g, " ")}
            {takenBy ? ` · Taken by ${takenBy.name ?? takenBy.email}` : ""}
          </div>
        </div>
        {isAdminRole(staff.role) && (
          <div className="flex flex-col items-end gap-2">
            <OrderActions orderId={o.id} status={o.status} pdfUrl={o.pdf_url} orderNumber={o.order_number} total={o.total_amount} buyerPhone={buyer?.phone ?? null} courier={o.courier} trackingNumber={o.tracking_number} />
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
            {/* The return control the owner never found lived per billed line,
                below the fold, on a page that goes read-only after delivery.
                This is the order-level door to the very same panel. */}
            {returnableBills.length > 0 && (
              <a
                href="#returns"
                className="flex items-center gap-1.5 font-body uppercase"
                style={{ fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px", color: palette.crimsonText, border: `1px solid ${palette.crimsonBorder}` }}
              >
                <Undo2 size={12} /> Create return
              </a>
            )}
          </div>
        )}
      </div>

      {/* UX sprint — logistics trail once the order moves past confirm. */}
      {(o.courier || o.tracking_number || o.packed_at || o.out_for_delivery_at || o.delivered_at) && (
        <div className="mt-4 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
          <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Delivery</div>
          <div className="font-body mt-1" style={{ fontSize: 12, lineHeight: 1.7, color: palette.softBlack }}>
            {o.packed_at && <>Packed {fmt(o.packed_at)}<br /></>}
            {o.out_for_delivery_at && <>Out for delivery {fmt(o.out_for_delivery_at)}<br /></>}
            {o.delivered_at && <>Delivered {fmt(o.delivered_at)}<br /></>}
            {(o.courier || o.tracking_number) && (
              <>{[o.courier, o.tracking_number].filter(Boolean).join(" · ")}<br /></>
            )}
            {o.tracking_note}
          </div>
          {o.tracking_image_ref && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={`/api/drive-photo?id=${encodeURIComponent(o.tracking_image_ref)}&s=600`} alt="Tracking sheet" className="mt-2" style={{ maxWidth: 280, width: "100%", border: "1px solid rgba(26,26,26,0.1)" }} />
          )}
        </div>
      )}

      <div className="mt-6" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
        {(o.items ?? []).map((it, i) => {
          const mapped = billLineOf.get(i);
          const billedQty = mapped ? Number(mapped.bill.items[mapped.billIndex]?.qty) || 0 : 0;
          const returnedQty = mapped ? returnedOf(mapped.bill.id, mapped.billIndex) : 0;
          return (
          <div key={`${it.sku}-${i}`} className="flex items-start gap-3 py-3" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
            {it.image_url ? (
              <ZoomImage src={it.image_url} alt={it.title} width={56} height={70} />
            ) : (
              <div className="relative flex-shrink-0" style={{ width: 56, height: 70, background: palette.ivoryDeep }} />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-display" style={{ fontSize: 14, color: palette.black, fontWeight: 500 }}>{it.title}</div>
              <div className="font-body mt-0.5" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.1em" }}>
                {it.custom ? "custom item · not on portal" : `${it.sku} · ${(it.stock_state ?? "").replace(/_/g, " ")}${it.restock_days ? ` · ${it.restock_days}d` : ""}`}{it.special_request ? " · SPECIAL QTY REQUEST" : ""}
                {!it.custom && <LineHsnEditor orderId={o.id} index={i} hsn={it.hsn ?? null} options={hsnOptions} />}
              </div>
              {moqFlags.get(it.sku) && (
                <div className="font-body mt-1.5 p-2" style={{ fontSize: 10.5, lineHeight: 1.5, background: "#FBF3E2", color: "#8a6d1a", border: "1px solid rgba(196,163,90,0.4)" }}>
                  <b>Below vendor production minimum</b> — {moqFlags.get(it.sku)!.message.replace("Below vendor production minimum — ", "")}
                  {moqFlags.get(it.sku)!.age && (
                    <span style={{ color: palette.mutedGreige }}> · supply {moqFlags.get(it.sku)!.age}</span>
                  )}
                </div>
              )}
              {it.original_price != null && it.original_price !== it.unit_price && (
                <div className="font-body mt-0.5" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
                  Price override — list {formatINR(it.original_price)}, billed {formatUnitINR(it.unit_price)} (internal note, not on the invoice)
                </div>
              )}
              {it.actual_qty != null && (
                <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep, fontWeight: 600 }}>
                  GST split — actual: {it.actual_qty} pc @ {formatINR((it.qty * it.unit_price) / it.actual_qty)} (billed as {it.qty} × {formatUnitINR(it.unit_price)})
                </div>
              )}
              <LineStateControls
                orderId={o.id}
                index={i}
                state={effectiveLineState(it, o.status)}
                holdNote={it.hold_note ?? null}
                billNumber={it.billed_in ? billNumberById.get(it.billed_in) ?? null : null}
                locked={lineEditLocked}
                returnedQty={returnedQty}
                billedQty={billedQty || undefined}
              />
              {/* Returns happen AFTER delivery, so this control must not sit
                  inside the !locked branch — it is gated on the line being
                  billed and on something still being returnable. */}
              {isAdminRole(staff.role) && mapped && billedQty - returnedQty > 0 && (
                <ReturnPanel
                  orderId={o.id}
                  billId={mapped.bill.id}
                  billNumber={mapped.bill.bill_number}
                  bill={sourceBillOf(mapped.bill)}
                  lines={returnLinesFor(mapped.bill)}
                  focusIndex={mapped.billIndex}
                />
              )}
            </div>
            <div className="text-right">
              <div className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>{it.qty} × {formatUnitINR(it.unit_price)}</div>
              <div className="font-display mt-0.5" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{formatINR(it.qty * it.unit_price)}</div>
            </div>
          </div>
          );
        })}
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
      {/* Credit settles an order exactly as an advance does, so the block has
          to mount for credit alone — an order with no advance was showing no
          balance due at all. */}
      {((o.advance_amount ?? 0) > 0 || creditApplied > 0) && (
        <div className="mt-3 p-3" style={{ background: palette.ivoryDeep }}>
          {(o.advance_amount ?? 0) > 0 && (
            <div className="flex justify-between font-body" style={{ fontSize: 12, color: palette.softBlack }}>
              <span>Advance received{o.payment_method ? ` (${o.payment_method})` : ""}</span><span>{formatINR(o.advance_amount)}</span>
            </div>
          )}
          {creditApplied > 0 && (
            <div className="flex justify-between font-body mt-1" style={{ fontSize: 12, color: palette.softBlack }}>
              <span>Credit applied from the wallet</span><span>− {formatINR(creditApplied)}</span>
            </div>
          )}
          <div className="flex justify-between font-body mt-1" style={{ fontSize: 13, color: palette.goldDeep, fontWeight: 600 }}>
            <span>Balance due</span><span>{formatINR(balanceDue)}</span>
          </div>
          {o.payment_notes && <div className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige }}>{o.payment_notes}</div>}
        </div>
      )}

      {/* Split billing (18 Aug) — bill the confirmed lines; hold the rest. */}
      {!billingLocked && billable.length > 0 && (
        <GenerateBillBar
          orderId={o.id}
          billableCount={billable.length}
          billableTotal={formatINR(billableTotals.total)}
          orderClosed={lineEditLocked}
        />
      )}
      {bills.length > 0 && (
        <div className="mt-5">
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Bills against this order</div>
          {bills.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-2 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
              <div className="min-w-0">
                <div className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>{b.bill_number}</div>
                <div className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                  {new Date(b.bill_date + "T12:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                  {" · "}{(b.items ?? []).length} line{(b.items ?? []).length === 1 ? "" : "s"}
                  {b.advance_applied > 0 ? ` · advance ${formatINR(b.advance_applied)} applied` : ""}
                  {isAdminRole(staff.role) && o.status !== "cancelled" && (
                    <>
                      {" "}
                      <DateCorrection
                        kind="bill"
                        targetId={b.id}
                        documentNumber={b.bill_number}
                        currentDate={b.bill_date}
                        floorDate={orderDay}
                      />
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{formatINR(b.total)}</span>
                {b.pdf_url && (
                  <a href={b.pdf_url} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>
                    PDF
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Returns were reachable only from a per-line control on a billed line,
          which is not where anyone looks once a parcel comes back. The entry
          point belongs with the bills — a return is raised against one — and
          each row routes into the SAME ReturnPanel the line control opens, so
          there is one return flow, not two. */}
      {isAdminRole(staff.role) && returnableBills.length > 0 && (
        <div id="returns" className="mt-5 p-3" style={{ background: palette.ivory, border: `1px solid ${palette.crimsonBorder}` }}>
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.crimsonText }}>Create a return</div>
          <p className="font-body mt-1" style={{ fontSize: 11, lineHeight: 1.6, color: palette.softBlack }}>
            Goods come back against the bill they went out on. The credit note prices them the way that bill priced the sale, puts the
            pieces back into stock, and credits the party&apos;s wallet.
          </p>
          {returnableBills.map(({ bill: b, remaining }) => (
            <div key={b.id} className="mt-2.5 pt-2.5" style={{ borderTop: "1px solid rgba(26,26,26,0.08)" }}>
              <div className="font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>
                <b style={{ color: palette.black }}>{b.bill_number}</b> · {remaining} pc still returnable
              </div>
              <ReturnPanel
                orderId={o.id}
                billId={b.id}
                billNumber={b.bill_number}
                bill={sourceBillOf(b)}
                lines={returnLinesFor(b)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Lineage, in one place: what came back, what it was credited at, what
          of that credit has been spent on this order, and what the party still
          holds. Notes are documents — a wrong one is voided, never deleted. */}
      {(credit.notes.length > 0 || creditApplied > 0 || (isAdminRole(staff.role) && wallet.balance !== 0)) && (
        <div className="mt-5">
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Returns &amp; credit</div>
          {credit.notes.map((n) => {
            const pieces = ((n.items ?? []) as unknown as { qty?: number | null }[]).reduce((s, it) => s + (Number(it?.qty) || 0), 0);
            const voided = n.status !== "issued";
            return (
              <div key={n.id} className="flex items-center justify-between gap-2 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black, textDecoration: voided ? "line-through" : "none" }}>{n.note_number}</span>
                    {voided && (
                      <span className="font-body uppercase inline-block" style={{ fontSize: 8.5, letterSpacing: "0.1em", padding: "3px 8px", background: palette.crimsonSoft, color: palette.crimsonText, fontWeight: 600 }}>Void</span>
                    )}
                  </div>
                  <div className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                    {new Date(n.note_date + "T12:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    {pieces > 0 ? ` · ${pieces} pc returned` : ""}
                    {n.source_bill_number ? ` · against ${n.source_bill_number}` : ""}
                    {n.reason ? ` · ${n.reason}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: voided ? palette.mutedGreige : palette.black }}>{formatINR(Number(n.total) || 0)}</span>
                  <a href={`/api/credit-notes/${n.id}/pdf`} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>
                    PDF
                  </a>
                </div>
              </div>
            );
          })}
          {/* "Sale records updated" has to be legible on the ORDER, not only
              as a chip beside whichever line it happened on. */}
          {returnedPieces > 0 && (
            <div className="flex justify-between font-body mt-2" style={{ fontSize: 12, color: palette.softBlack }}>
              <span>Pieces returned</span><span>{returnedPieces} of {billedPieces} billed</span>
            </div>
          )}
          {credit.creditTotal > 0 && (
            <div className="flex justify-between font-body mt-2" style={{ fontSize: 12, color: palette.softBlack }}>
              <span>Credited against this order</span><span>{formatINR(credit.creditTotal)}</span>
            </div>
          )}
          {creditApplied > 0 && (
            <div className="flex justify-between font-body mt-1" style={{ fontSize: 12, color: palette.softBlack }}>
              <span>Credit spent on this order</span><span>{formatINR(creditApplied)}</span>
            </div>
          )}
          {/* A wallet is a SUM over the ledger, so a negative one is a fault,
              not a number to format quietly past. */}
          {isAdminRole(staff.role) && wallet.balance < 0 && (
            <div className="font-body mt-2 p-2.5" style={{ fontSize: 11.5, fontWeight: 600, background: palette.crimsonSoft, color: palette.crimsonText, border: `1px solid ${palette.crimsonBorder}` }}>
              Wallet overdrawn by {formatINR(Math.abs(wallet.balance))} — investigate before any more credit is applied.
            </div>
          )}
          {isAdminRole(staff.role) && wallet.balance > 0 && (
            <ApplyCreditBar orderId={o.id} balance={wallet.balance} maxApplicable={balanceDue} />
          )}
        </div>
      )}

      {o.notes && (
        <div className="mt-5 p-3" style={{ background: palette.ivoryDeep }}>
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Buyer note</div>
          <p className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6 }}>{o.notes}</p>
        </div>
      )}

      <NotesPanel entityType="order" entityId={o.id} notes={await listEntityNotes("order", o.id)} revalidate={`/admin/orders/${o.id}`} />
    </div>
  );
}

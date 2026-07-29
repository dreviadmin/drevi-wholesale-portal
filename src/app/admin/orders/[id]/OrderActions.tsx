"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOrderStatus, sendInvoice, uploadTrackingSheet, type StageDetails } from "@/app/admin/orders/actions";
import { sharePdfFile, invoiceFileName, waPhone } from "@/lib/share";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { OrderStatus } from "@/lib/types";

export function OrderActions({
  orderId,
  status,
  pdfUrl,
  orderNumber,
  total,
  buyerPhone,
  courier,
  trackingNumber,
}: {
  orderId: string;
  status: OrderStatus;
  pdfUrl?: string | null;
  orderNumber?: string;
  total?: number;
  buyerPhone?: string | null;
  courier?: string | null;
  trackingNumber?: string | null;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [form, setForm] = useState<StageDetails>({ courier: courier ?? "", trackingNumber: trackingNumber ?? "", trackingNote: "" });
  const [sheet, setSheet] = useState<File | null>(null);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 3500); }

  function act(next: OrderStatus, opts?: { sendInvoice?: boolean; confirmMsg?: string; details?: StageDetails }) {
    if (opts?.confirmMsg && !window.confirm(opts.confirmMsg)) return;
    start(async () => {
      const res = await setOrderStatus(orderId, next, { sendInvoice: opts?.sendInvoice, details: opts?.details });
      router.refresh();
      if (!res.ok) flash(res.error ?? "Failed");
      else if (opts?.sendInvoice) flash(res.invoiceSent ? "Invoice sent" : "PDF generated · Interakt not configured");
    });
  }

  // UX sprint — out-for-delivery captures the courier, AWB and the tracking
  // sheet in one motion. Photo upload is best-effort after the stage change.
  function dispatchNow() {
    start(async () => {
      const res = await setOrderStatus(orderId, "out_for_delivery", { details: form });
      if (!res.ok) { flash(res.error ?? "Failed"); return; }
      if (sheet) {
        const fd = new FormData();
        fd.set("photo", sheet);
        const up = await uploadTrackingSheet(orderId, fd);
        if (!up.ok) flash(up.error ?? "Stage saved, but the tracking sheet failed to upload");
      }
      setDispatchOpen(false);
      router.refresh();
    });
  }
  function fireInvoice() {
    start(async () => {
      const res = await sendInvoice(orderId);
      router.refresh();
      if (!res.ok) flash(res.error ?? "Failed");
      else flash(res.sent ? "Invoice sent" : "PDF refreshed · Interakt not configured");
    });
  }

  function shareText() {
    return `Drevi order ${orderNumber ?? ""} — total ${total != null ? formatINR(total) : ""}. Invoice PDF: ${pdfUrl}`;
  }

  // Share the actual PDF file (named Drevi-Invoice-…) — buyers distrust bare
  // links AND anonymous PDFs. Falls back to a text share, then to copying.
  async function shareInvoice() {
    if (!pdfUrl) { flash("Generate the invoice first (Send Invoice)"); return; }
    const r = await sharePdfFile({ url: pdfUrl, filename: invoiceFileName(orderNumber ?? "order"), text: shareText() });
    if (r === "shared" || r === "cancelled") return;
    if (navigator.share) {
      try { await navigator.share({ title: `Drevi ${orderNumber ?? "invoice"}`, text: shareText() }); return; } catch { /* cancelled */ }
    }
    await navigator.clipboard?.writeText(shareText());
    flash("Invoice link copied");
  }

  // Straight into the CUSTOMER'S chat (no recipient picker). File-sharing
  // can't target a chat, so this sends the labelled link; use Share to attach
  // the PDF itself.
  function shareWhatsAppDirect() {
    if (!pdfUrl) { flash("Generate the invoice first (Send Invoice)"); return; }
    const digits = waPhone(buyerPhone);
    const base = digits ? `https://wa.me/${digits}` : "https://wa.me/";
    if (!digits) flash("No phone on the buyer — opening the picker");
    window.open(`${base}?text=${encodeURIComponent(shareText())}`, "_blank", "noopener");
  }

  const btn = (label: string, onClick: () => void, primary = false) => (
    <button type="button" onClick={onClick} disabled={isPending} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px", background: primary ? palette.black : "transparent", color: primary ? palette.ivory : palette.black, border: primary ? "none" : `1px solid ${palette.black}` }}>{label}</button>
  );

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2 flex-wrap justify-end">
        {status === "submitted" && (
          <>
            {btn("Confirm", () => act("confirmed"), true)}
            {btn("Confirm & Send Invoice", () => act("confirmed", { sendInvoice: true }))}
          </>
        )}
        {status === "confirmed" && btn("Mark Packed", () => act("packed"), true)}
        {(status === "confirmed" || status === "packed") && btn("Out for Delivery", () => setDispatchOpen(true), status === "packed")}
        {(status === "confirmed" || status === "packed" || status === "out_for_delivery") && btn("Mark Delivered", () => act("delivered"), status === "out_for_delivery")}
        {(status === "submitted" || status === "confirmed") && btn("Send Invoice", fireInvoice)}
        {pdfUrl && btn("Share PDF", shareInvoice)}
        {pdfUrl && btn("WhatsApp Buyer", shareWhatsAppDirect)}
        {(status === "submitted" || status === "confirmed" || status === "packed") && btn("Cancel", () => act("cancelled", { confirmMsg: "Cancel this order? Stock returns to the shelf if it had left." }))}
      </div>
      {toast && <span className="font-body" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.04em" }}>{toast}</span>}

      {dispatchOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !isPending && setDispatchOpen(false)}>
          <div className="w-full sm:max-w-sm" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display" style={{ fontSize: 15, fontWeight: 600, color: palette.black }}>Out for delivery</h3>
            <div className="flex flex-col gap-2.5 mt-3">
              <label className="flex flex-col gap-1"><span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.softBlack }}>Courier</span>
                <input value={form.courier ?? ""} onChange={(e) => setForm((f) => ({ ...f, courier: e.target.value }))} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13 }} />
              </label>
              <label className="flex flex-col gap-1"><span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.softBlack }}>Tracking / AWB number</span>
                <input value={form.trackingNumber ?? ""} onChange={(e) => setForm((f) => ({ ...f, trackingNumber: e.target.value }))} className="font-mono bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13 }} />
              </label>
              <label className="flex flex-col gap-1"><span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.softBlack }}>Note</span>
                <input value={form.trackingNote ?? ""} onChange={(e) => setForm((f) => ({ ...f, trackingNote: e.target.value }))} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13 }} />
              </label>
              <label className="flex items-center gap-2 cursor-pointer" style={{ border: "1px dashed rgba(26,26,26,0.3)", padding: "9px 10px" }}>
                <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: palette.softBlack }}>
                  {sheet ? sheet.name : "Tracking sheet photo (optional)"}
                </span>
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setSheet(e.target.files?.[0] ?? null)} />
              </label>
            </div>
            <div className="flex gap-2 mt-4">
              <button type="button" onClick={dispatchNow} disabled={isPending} className="flex-1 font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 0" }}>
                {isPending ? "Saving…" : "Dispatch"}
              </button>
              <button type="button" onClick={() => setDispatchOpen(false)} disabled={isPending} className="font-body uppercase px-5" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

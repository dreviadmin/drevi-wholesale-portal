"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { regenerateBillPdf } from "@/app/admin/orders/actions";
import { sharePdfFile, downloadPdfFile, invoiceFileName, waPhone } from "@/lib/share";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";

// Manual share for ONE bill (Ansh, 30 Sep: "once the bill was generated there
// was no manual option to share it. I told you to add these."). The order
// header already had Download / Share / WhatsApp for the whole-order invoice,
// but a bill row offered only a bare "PDF" link — and nothing at all when its
// file had failed to store. The WhatsApp API is not connected, so these ARE the
// way an invoice reaches a buyer today.
export function BillShareActions({
  billId, billNumber, orderNumber, total, pdfUrl, buyerPhone, cancelled, canRegenerate,
}: {
  billId: string;
  billNumber: string;
  orderNumber: string;
  total: number;
  /** A freshly signed, year-long link — minted by the page, not the 30-day one on the row. */
  pdfUrl: string | null;
  buyerPhone: string | null;
  cancelled: boolean;
  canRegenerate: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const flash = (m: string) => { setNote(m); setTimeout(() => setNote((n) => (n === m ? null : n)), 5000); };

  const link = (label: string, onClick: () => void, title?: string) => (
    <button type="button" onClick={onClick} disabled={pending} title={title} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline", textUnderlineOffset: 3 }}>
      {label}
    </button>
  );

  // A cancelled bill is kept for the record, never sent again.
  if (cancelled) {
    return pdfUrl ? (
      <a href={pdfUrl} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.mutedGreige, textDecoration: "underline" }}>PDF</a>
    ) : null;
  }

  if (!pdfUrl) {
    return (
      <span className="flex items-center gap-2">
        <span className="font-body" style={{ fontSize: 10, color: palette.crimsonText }}>No PDF yet</span>
        {canRegenerate && link(pending ? "Making…" : "Make PDF", () => start(async () => {
          const r = await regenerateBillPdf(billId).catch(() => ({ ok: false, error: "Could not reach the server — retry." }));
          if (!r.ok) flash(r.error ?? "Failed");
          router.refresh();
        }))}
        {note && <span className="font-body" style={{ fontSize: 10, color: palette.crimsonText }}>{note}</span>}
      </span>
    );
  }

  const text = `Drevi Fashion invoice ${billNumber} (order ${orderNumber}) — ${formatINR(total)}.\nPDF: ${pdfUrl}`;
  const filename = invoiceFileName(billNumber);

  function whatsapp() {
    const digits = waPhone(buyerPhone);
    if (!digits) flash("No phone on this buyer — pick the chat in WhatsApp");
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  }

  async function share() {
    // The PDF FILE itself where the device can (phones), else the text + link.
    const r = await sharePdfFile({ url: pdfUrl!, filename, text });
    if (r === "shared" || r === "cancelled") return;
    if (navigator.share) {
      try { await navigator.share({ title: `Drevi ${billNumber}`, text }); return; } catch { /* cancelled */ }
    }
    await copy();
  }

  async function download() {
    const r = await downloadPdfFile({ url: pdfUrl!, filename });
    flash(r === "saved" ? "Invoice downloaded" : "Download failed — try Make PDF again");
  }

  async function copy() {
    try { await navigator.clipboard.writeText(pdfUrl!); flash("Invoice link copied"); } catch { flash("Could not copy — use Share"); }
  }

  return (
    <span className="flex items-center gap-2.5 flex-wrap justify-end">
      {link("WhatsApp", whatsapp, buyerPhone ? `Open the buyer's chat (${buyerPhone}) with the invoice link` : "No phone on this buyer — opens the WhatsApp picker")}
      {link("Share", () => void share(), "Share the PDF file (phone) or the link")}
      {link("Download", () => void download())}
      {link("Copy link", () => void copy())}
      {note && <span className="font-body w-full text-right" style={{ fontSize: 10, color: palette.goldDeep }}>{note}</span>}
    </span>
  );
}

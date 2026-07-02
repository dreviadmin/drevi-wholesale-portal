"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOrderStatus, sendInvoice } from "@/app/admin/orders/actions";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { OrderStatus } from "@/lib/types";

export function OrderActions({
  orderId,
  status,
  pdfUrl,
  orderNumber,
  total,
}: {
  orderId: string;
  status: OrderStatus;
  pdfUrl?: string | null;
  orderNumber?: string;
  total?: number;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [toast, setToast] = useState<string | null>(null);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 3500); }

  function act(next: OrderStatus, opts?: { sendInvoice?: boolean; confirmMsg?: string }) {
    if (opts?.confirmMsg && !window.confirm(opts.confirmMsg)) return;
    start(async () => {
      const res = await setOrderStatus(orderId, next, { sendInvoice: opts?.sendInvoice });
      router.refresh();
      if (!res.ok) flash(res.error ?? "Failed");
      else if (opts?.sendInvoice) flash(res.invoiceSent ? "Invoice sent" : "PDF generated · Interakt not configured");
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

  async function shareInvoice() {
    if (!pdfUrl) { flash("Generate the invoice first (Send Invoice)"); return; }
    const text = `Drevi order ${orderNumber ?? ""} — total ${total != null ? formatINR(total) : ""}. Invoice PDF: ${pdfUrl}`;
    if (navigator.share) {
      try { await navigator.share({ title: `Drevi ${orderNumber ?? "invoice"}`, text }); return; } catch { /* cancelled */ }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
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
        {status === "confirmed" && btn("Mark Fulfilled", () => act("fulfilled"), true)}
        {(status === "submitted" || status === "confirmed") && btn("Send Invoice", fireInvoice)}
        {pdfUrl && btn("Share", shareInvoice)}
        {status !== "cancelled" && status !== "fulfilled" && btn("Cancel", () => act("cancelled", { confirmMsg: "Cancel this order?" }))}
      </div>
      {toast && <span className="font-body" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.04em" }}>{toast}</span>}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { palette } from "@/lib/palette";
import { cancelBill } from "../actions";

// A tax invoice is cancelled and kept, never deleted — so this asks for a
// reason the way voiding a credit note does, and the row survives saying who
// did it and why.

export function CancelBillButton({ billId, billNumber }: { billId: string; billNumber: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const res = await cancelBill(billId, reason);
      if (!res.ok) { setError(res.error ?? "Could not cancel it"); return; }
      setOpen(false); setReason("");
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="font-body uppercase"
        style={{ fontSize: 8.5, letterSpacing: "0.1em", border: "1px solid #9C3A31", color: "#9C3A31", padding: "5px 8px", background: "transparent" }}>
        Cancel bill
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={() => !pending && setOpen(false)}>
      <div className="w-full sm:max-w-md max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
        <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>Cancel {billNumber}</div>
        <p className="font-body mt-2" style={{ fontSize: 11.5, lineHeight: 1.6, color: palette.softBlack }}>
          The bill is kept and marked cancelled — an invoice is never deleted. Its lines go back to the order, where they can be
          billed again or returned against the order itself. The order, its delivery and its balance are untouched.
        </p>
        <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="Why is it being cancelled?"
          className="w-full mt-3 font-body" style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" }} />
        {error && <div className="font-body mt-2" style={{ fontSize: 11, color: "#9C3A31" }}>{error}</div>}
        <div className="flex gap-2 mt-4">
          <button type="button" disabled={pending || !reason.trim()} onClick={submit} className="flex-1 font-body uppercase disabled:opacity-40"
            style={{ fontSize: 10.5, letterSpacing: "0.16em", background: "#9C3A31", color: palette.ivory, padding: "12px 0" }}>
            {pending ? "Cancelling…" : "Cancel this bill"}
          </button>
          <button type="button" disabled={pending} onClick={() => setOpen(false)} className="font-body uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: palette.softBlack, padding: "12px 14px" }}>
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
}

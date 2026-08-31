"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, PauseCircle, RotateCcw, ReceiptText } from "lucide-react";
import { palette } from "@/lib/palette";
import { setLineState, generateOrderBill } from "@/app/admin/orders/actions";

// Line-level confirmation + split billing (Ansh, 18 Aug).
// Chip semantics: Pending (untouched) · Confirmed (stock reserved, will be on
// the next bill) · On hold (availability note for the customer) · Billed
// (immutable, shows its bill number).

function useFlash(): [string | null, (m: string) => void] {
  const [toast, setToast] = useState<string | null>(null);
  return [toast, (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); }];
}

const chip = (bg: string, fg: string) => ({
  fontSize: 8.5, letterSpacing: "0.1em", padding: "3px 8px", background: bg, color: fg, fontWeight: 600 as const,
});

export function LineStateControls({
  orderId, index, state, holdNote, billNumber, locked,
}: {
  orderId: string;
  index: number;
  state: "pending" | "confirmed" | "hold" | "billed";
  holdNote: string | null;
  billNumber: string | null;
  locked: boolean; // terminal order — no state changes
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [toast, flash] = useFlash();
  const [holdOpen, setHoldOpen] = useState(false);
  const [note, setNote] = useState(holdNote ?? "");

  function act(next: "confirmed" | "hold" | "pending", n?: string) {
    start(async () => {
      const r = await setLineState(orderId, index, next, n);
      if (!r.ok) { flash(r.error ?? "Failed"); return; }
      setHoldOpen(false);
      router.refresh();
    });
  }

  const label =
    state === "billed" ? `BILLED${billNumber ? ` · ${billNumber}` : ""}` :
    state === "confirmed" ? "CONFIRMED" :
    state === "hold" ? "ON HOLD" : "PENDING";
  const style =
    state === "billed" ? chip("rgba(31,107,69,0.12)", "#1F6B45") :
    state === "confirmed" ? chip("rgba(196,163,90,0.2)", palette.goldDeep) :
    state === "hold" ? chip("#F7DFDC", "#9C3A31") :
    chip("rgba(26,26,26,0.07)", palette.softBlack);

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-body uppercase inline-block" style={style}>{label}</span>
        {!locked && state !== "billed" && (
          <>
            {state !== "confirmed" && (
              <button type="button" disabled={pending} onClick={() => act("confirmed")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.08em", border: `1px solid ${palette.black}`, color: palette.black, padding: "3px 8px" }}>
                <Check size={10} /> Confirm
              </button>
            )}
            {state !== "hold" && (
              <button type="button" disabled={pending} onClick={() => { setNote(holdNote ?? ""); setHoldOpen(true); }} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.08em", border: "1px solid rgba(26,26,26,0.25)", color: palette.softBlack, padding: "3px 8px" }}>
                <PauseCircle size={10} /> Hold
              </button>
            )}
            {state !== "pending" && (
              <button type="button" disabled={pending} onClick={() => act("pending")} title="Back to pending" className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.08em", color: palette.mutedGreige, padding: "3px 4px" }}>
                <RotateCcw size={10} /> Reset
              </button>
            )}
          </>
        )}
      </div>
      {state === "hold" && holdNote && (
        <div className="font-body mt-1" style={{ fontSize: 10.5, color: "#9C3A31" }}>Availability: {holdNote}</div>
      )}
      {holdOpen && (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Availability note for the customer, e.g. ready in 2 weeks"
            className="font-body flex-1"
            style={{ fontSize: 11.5, minWidth: 220, border: "1px solid rgba(26,26,26,0.25)", background: "#fff", color: palette.black, padding: "6px 8px" }}
          />
          <button type="button" disabled={pending} onClick={() => act("hold", note)} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: palette.black, color: palette.ivory, padding: "7px 10px" }}>
            Put on hold
          </button>
          <button type="button" onClick={() => setHoldOpen(false)} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.1em", color: palette.mutedGreige, padding: "7px 4px" }}>
            Cancel
          </button>
        </div>
      )}
      {toast && <div className="font-body mt-1" style={{ fontSize: 10.5, color: "#9C3A31" }}>{toast}</div>}
    </div>
  );
}

export function GenerateBillBar({
  orderId, billableCount, billableTotal,
}: {
  orderId: string;
  billableCount: number;
  billableTotal: string; // pre-formatted ₹
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [toast, flash] = useFlash();
  const [open, setOpen] = useState(false);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [date, setDate] = useState(today);

  function run() {
    start(async () => {
      const r = await generateOrderBill(orderId, { billDate: date });
      if (!r.ok) { flash(r.error ?? "Failed"); return; }
      flash(`${r.billNumber} generated`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="mt-4 p-3" style={{ background: "rgba(196,163,90,0.1)", border: "1px solid rgba(196,163,90,0.4)" }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>
          <b>{billableCount}</b> confirmed line{billableCount === 1 ? "" : "s"} ready to bill · {billableTotal}
        </div>
        {!open ? (
          <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "9px 14px" }}>
            <ReceiptText size={13} /> Generate bill
          </button>
        ) : (
          <div className="flex items-center gap-1.5 flex-wrap">
            <label className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige }}>Bill date</label>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
              className="font-body"
              style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.25)", background: "#fff", color: palette.black, padding: "6px 8px" }}
            />
            <button type="button" disabled={pending} onClick={run} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "9px 14px" }}>
              {pending ? "Billing…" : "Bill now"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.mutedGreige, padding: "9px 4px" }}>
              Cancel
            </button>
          </div>
        )}
      </div>
      <div className="font-body mt-1" style={{ fontSize: 10, color: palette.mutedGreige }}>
        Bills only the confirmed lines — held and pending lines wait for their own bill. A past date is allowed; future dates are not.
      </div>
      {toast && <div className="font-body mt-1.5" style={{ fontSize: 11, color: palette.goldDeep, fontWeight: 600 }}>{toast}</div>}
    </div>
  );
}

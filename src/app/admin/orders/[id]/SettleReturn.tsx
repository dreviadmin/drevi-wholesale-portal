"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { splitLegs } from "@/lib/credit-core";
import { settleReturn } from "@/app/admin/credit-notes/actions";

// Ansh, 21 Sep: "In case of return, its not mandatory that the person will
// take a credit note: so there shall be 3 options (splittable):
//   1) Credit note  2) Refunded  3) Adjusted against balance payment"
//
// All three rows are visible at once — hiding them behind a disclosure repeats
// the bug this whole feature is fixing, which was a control nobody could find.
//
// ① IS COMPUTED, NEVER TYPED. It is the residual, so the legs cannot fail to
// sum to the note. That is also why there is no "amount kept" input: a third
// box is a third chance to enter a figure that does not reconcile.

const METHODS = ["Cash", "Bank transfer", "UPI", "Cheque"];

export interface SettleTarget {
  id: string;
  orderNumber: string;
  due: number;
}

export function SettleReturn({
  noteId, noteNumber, unsettled, targets,
}: {
  noteId: string;
  noteNumber: string;
  /** Note total less whatever has already been refunded or adjusted. */
  unsettled: number;
  /** The buyer's open orders — the owner asked that credit may be set against
   *  ANY of them, not only the order returned. */
  targets: SettleTarget[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [refund, setRefund] = useState("");
  const [adjust, setAdjust] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // One id per dialog: settle_return is idempotent on it, so a double tap or a
  // retry after a dropped response resolves to the rows the first attempt wrote.
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());

  const total = Math.round(unsettled * 100) / 100;
  const r = Math.max(0, Number(refund) || 0);
  const a = Math.max(0, Number(adjust) || 0);
  const split = useMemo(() => splitLegs(total, r, a), [total, r, a]);
  const target = targets.find((t) => t.id === targetId) ?? null;
  const adjustCap = target ? Math.min(total, target.due) : 0;
  const overAdjust = a > adjustCap + 0.001;

  const ready =
    !pending &&
    split.ok &&
    !overAdjust &&
    (r > 0 || a > 0) &&
    (r === 0 || method.trim() !== "") &&
    (a === 0 || !!targetId);

  function submit() {
    setError(null);
    start(async () => {
      const res = await settleReturn({
        noteId, refund: r, adjust: a,
        orderId: a > 0 ? targetId : null,
        method: r > 0 ? method : null,
        reference, clientRef,
      });
      if (!res.ok) { setError(res.error ?? "Could not record the settlement"); return; }
      setOpen(false);
      setRefund(""); setAdjust(""); setMethod(""); setReference("");
      setClientRef(crypto.randomUUID());
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 font-body uppercase"
        style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, padding: "6px 10px", background: "transparent" }}
      >
        Settle {formatINR(total)}
      </button>
    );
  }

  const row = { fontSize: 12, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "7px 9px", width: 120 } as const;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={() => !pending && setOpen(false)}>
      <div className="w-full sm:max-w-lg max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>How was this return settled?</span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close"><X size={16} color={palette.softBlack} /></button>
        </div>
        <div className="font-body mt-1" style={{ fontSize: 11.5, color: palette.softBlack }}>
          {noteNumber} · <b style={{ color: palette.black }}>{formatINR(total)}</b> returned
        </div>

        {/* ① kept — the residual */}
        <div className="flex items-center justify-between mt-3 pt-2" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
          <span className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>Kept as credit</span>
          <span className="font-display" style={{ fontSize: 15, fontWeight: 600, color: palette.goldDeep }}>{formatINR(split.held)}</span>
        </div>
        <div className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
          Whatever is not refunded or set against an order stays on the party&apos;s account.
        </div>

        {/* ② refunded */}
        <div className="flex items-center justify-between mt-3">
          <span className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>Refunded</span>
          <input type="number" min="0" step="any" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="0" style={row} />
        </div>
        {r > 0 && (
          <>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {METHODS.map((m) => (
                <button key={m} type="button" onClick={() => setMethod(m)} className="font-body uppercase"
                  style={{ fontSize: 9, letterSpacing: "0.1em", padding: "6px 9px", background: method === m ? palette.black : "transparent", color: method === m ? palette.ivory : palette.softBlack, border: "1px solid rgba(26,26,26,0.2)" }}>
                  {m}
                </button>
              ))}
            </div>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque number (optional)"
              className="w-full mt-1.5 font-body" style={{ fontSize: 11.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "7px 9px" }} />
          </>
        )}

        {/* ③ adjusted */}
        <div className="flex items-center justify-between mt-3">
          <span className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>Against a balance</span>
          <input type="number" min="0" step="any" value={adjust} onChange={(e) => setAdjust(e.target.value)} placeholder="0"
            disabled={targets.length === 0} style={{ ...row, opacity: targets.length === 0 ? 0.5 : 1 }} />
        </div>
        {targets.length === 0 ? (
          <div className="font-body mt-1" style={{ fontSize: 10, color: palette.mutedGreige }}>
            This party has no order with a balance outstanding — refund it or leave it on account.
          </div>
        ) : (
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="w-full mt-1.5 font-body"
            style={{ fontSize: 11.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "7px 9px" }}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>{t.orderNumber} — {formatINR(t.due)} due</option>
            ))}
          </select>
        )}
        {overAdjust && target && (
          <div className="font-body mt-1" style={{ fontSize: 10.5, color: "#9C3A31" }}>
            {target.orderNumber} only has {formatINR(target.due)} outstanding.
          </div>
        )}

        {!split.ok && split.error && (
          <div className="font-body mt-2" style={{ fontSize: 10.5, color: "#9C3A31" }}>{split.error}</div>
        )}
        {error && <div className="font-body mt-2" style={{ fontSize: 11, color: "#9C3A31" }}>{error}</div>}

        <div className="flex gap-2 mt-4">
          <button type="button" disabled={!ready} onClick={submit} className="flex-1 font-body uppercase disabled:opacity-40"
            style={{ fontSize: 10, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "12px 0" }}>
            {pending ? "Recording…" : "Record settlement"}
          </button>
          <button type="button" disabled={pending} onClick={() => setOpen(false)} className="font-body uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: palette.softBlack, padding: "12px 12px" }}>
            Leave as credit
          </button>
        </div>
        <div className="font-body mt-2" style={{ fontSize: 9.5, color: palette.mutedGreige, lineHeight: 1.5 }}>
          Leaving it as credit writes nothing — the whole note stays on the party&apos;s account and this panel reopens whenever they decide.
        </div>
      </div>
    </div>
  );
}

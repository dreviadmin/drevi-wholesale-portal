"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X, IndianRupee } from "lucide-react";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { recordPayment } from "../actions";

// Recording money received, separated from the order editor on purpose: the
// editor disappears past 'confirmed', and a balance is normally settled AFTER
// delivery. See recordPayment's own note for the reasoning.

const METHODS = ["Cash", "Bank transfer", "UPI", "Cheque"];

export function RecordPayment({ orderId, balance: rawBalance }: { orderId: string; balance: number }) {
  // The page computes the balance as total - advance - credit, which in binary
  // floating point lands on 30977.379999999997. Unrounded, "Paid in full" typed
  // exactly that into the box. Rounded here so the figure the operator sees and
  // submits is the figure they are owed; the server rounds again regardless.
  const balance = Math.round(rawBalance * 100) / 100;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const typed = Number(amount);
  const over = amount.trim() !== "" && typed > balance;

  function submit() {
    setError(null);
    start(async () => {
      const res = await recordPayment(orderId, { amount: typed, method, note });
      if (!res.ok) { setError(res.error ?? "Could not record it"); return; }
      setOpen(false);
      setAmount(""); setMethod(""); setNote("");
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex items-center gap-1.5 font-body uppercase"
        style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "9px 12px" }}
      >
        <IndianRupee size={12} /> Record payment
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={() => !pending && setOpen(false)}>
      <div className="w-full sm:max-w-md max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>Record payment</span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close"><X size={16} color={palette.softBlack} /></button>
        </div>

        <div className="font-body mt-2" style={{ fontSize: 12, color: palette.softBlack }}>
          Outstanding <b style={{ color: palette.black }}>{formatINR(balance)}</b>
        </div>

        <label className="block mt-3 font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Amount received ₹</span>
          <input
            type="number" inputMode="decimal" min="0" step="any" autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={String(balance)}
            className="w-full mt-1 font-body"
            style={{ fontSize: 14, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" }}
          />
        </label>
        {/* Said before the server says it — the action refuses an overpayment
            rather than clamping, so the operator should see it coming. */}
        {over && (
          <div className="font-body mt-1" style={{ fontSize: 10.5, color: "#9C3A31" }}>
            More than the {formatINR(balance)} outstanding.
          </div>
        )}
        <button
          type="button"
          onClick={() => setAmount(String(balance))}
          className="mt-1 font-body uppercase"
          style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, background: "transparent", border: "none", padding: 0 }}
        >
          Paid in full · {formatINR(balance)}
        </button>

        <div className="font-body uppercase mt-3" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>How</div>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {METHODS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className="font-body uppercase"
              style={{
                fontSize: 9.5, letterSpacing: "0.1em", padding: "7px 10px",
                background: method === m ? palette.black : "transparent",
                color: method === m ? palette.ivory : palette.softBlack,
                border: "1px solid rgba(26,26,26,0.2)",
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <input
          value={METHODS.includes(method) ? "" : method}
          onChange={(e) => setMethod(e.target.value)}
          placeholder="or type another method"
          className="w-full mt-1.5 font-body"
          style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" }}
        />

        <label className="block mt-3 font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Reference (optional)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="UTR, cheque number, who handed it over"
            className="w-full mt-1 font-body"
            style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" }}
          />
        </label>

        {error && <div className="font-body mt-2" style={{ fontSize: 11, color: "#9C3A31" }}>{error}</div>}

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            disabled={pending || !(typed > 0) || over || !method.trim()}
            onClick={submit}
            className="flex-1 font-body uppercase disabled:opacity-40"
            style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.black, color: palette.ivory, padding: "12px 0" }}
          >
            {pending ? "Recording…" : "Record payment"}
          </button>
          <button type="button" disabled={pending} onClick={() => setOpen(false)} className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.14em", color: palette.softBlack, padding: "12px 14px" }}>
            Cancel
          </button>
        </div>
        <div className="font-body mt-2" style={{ fontSize: 9.5, color: palette.mutedGreige, lineHeight: 1.5 }}>
          Adds to what this order has already received and appends a dated line to its payment history. It does not change the order&apos;s status.
        </div>
      </div>
    </div>
  );
}

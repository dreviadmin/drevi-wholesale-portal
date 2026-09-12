"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";

// The buyer's own credit, on their own pages (Ansh, 12 Sep). Credit is the
// buyer's money, so it is shown plainly — but nothing else from the wallet
// comes across: no staff notes, no cost, no other party. The card hides itself
// entirely when there has never been any credit, so an ordinary buyer's home
// page is unchanged.

export interface BuyerWallet {
  balance: number;
  notes: { id: string; number: string; date: string; total: number; remaining: number; reason: string; voided: boolean }[];
  history: { id: string; date: string; amount: number; orderNumber: string | null; kind: "credited" | "used" | "returned" }[];
}

const fmtDate = (d: string) =>
  new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function BuyerWalletCard({ wallet }: { wallet: BuyerWallet | null }) {
  const [open, setOpen] = useState(false);
  if (!wallet || (wallet.balance <= 0 && wallet.notes.length === 0)) return null;

  const live = wallet.notes.filter((n) => !n.voided);
  const label = (h: BuyerWallet["history"][number]) =>
    h.kind === "credited"
      ? "Credit note issued"
      : h.kind === "used"
        ? `Used${h.orderNumber ? ` on ${h.orderNumber}` : ""}`
        : `Returned to your credit${h.orderNumber ? ` from ${h.orderNumber}` : ""}`;

  return (
    <section className="mt-5" style={{ background: palette.ivory, border: `1px solid ${palette.gold}` }}>
      <div className="px-4 py-3.5 flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.goldDeep }}>
            Your credit with Drevi
          </div>
          <div className="font-display mt-1" style={{ fontSize: 26, fontWeight: 600, color: palette.black }}>
            {formatINR(wallet.balance)}
          </div>
          <div className="font-body mt-0.5" style={{ fontSize: 11, color: palette.mutedGreige }}>
            {wallet.balance > 0
              ? "We set this against your balance — no need to do anything."
              : "Fully used against your orders."}
          </div>
        </div>
        {wallet.history.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1 font-body uppercase"
            style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.goldDeep }}
          >
            {open ? "Hide" : "Details"}
            <ChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : undefined }} />
          </button>
        )}
      </div>

      {open && (
        <div className="px-4 pb-4" style={{ borderTop: "1px solid rgba(26,26,26,0.08)" }}>
          {live.length > 0 && (
            <div className="mt-3">
              <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>
                Credit notes
              </div>
              {live.map((n) => (
                <div key={n.id} className="flex items-baseline justify-between gap-3 mt-1.5 flex-wrap">
                  <div className="min-w-0">
                    <a
                      href={`/api/credit-notes/${n.id}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono"
                      style={{ fontSize: 12, fontWeight: 600, color: palette.black, textDecoration: "underline" }}
                    >
                      {n.number}
                    </a>
                    <span className="font-body" style={{ fontSize: 11, color: palette.mutedGreige }}> · {fmtDate(n.date)}</span>
                    {n.reason && (
                      <div className="font-body truncate" style={{ fontSize: 11, color: palette.softBlack }}>{n.reason}</div>
                    )}
                  </div>
                  <div className="font-body text-right" style={{ fontSize: 11.5, color: palette.softBlack }}>
                    {formatINR(n.total)}
                    <span style={{ color: palette.mutedGreige }}> · {formatINR(n.remaining)} left</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4">
            <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>
              History
            </div>
            {wallet.history.map((h) => (
              <div key={`${h.kind}-${h.id}`} className="flex items-baseline justify-between gap-3 mt-1.5">
                <div className="font-body min-w-0 truncate" style={{ fontSize: 11.5, color: palette.softBlack }}>
                  {label(h)}
                  <span style={{ color: palette.mutedGreige }}> · {fmtDate(h.date)}</span>
                </div>
                <div className="font-mono" style={{ fontSize: 11.5, color: h.amount < 0 ? palette.softBlack : "#1F6B45", whiteSpace: "nowrap" }}>
                  {h.amount < 0 ? "−" : "+"}{formatINR(Math.abs(h.amount))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

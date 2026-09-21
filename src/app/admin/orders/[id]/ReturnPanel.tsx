"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Minus, Plus, Undo2, Wallet, X } from "lucide-react";
import { palette } from "@/lib/palette";
import { formatINR, formatUnitINR } from "@/lib/format";
import { DraftNotice } from "@/components/DraftNotice";
import { useDraft } from "@/lib/useDraft";
import { computeCreditTotals, validateCreditAmount, type SourceBill } from "@/lib/credit-core";
import { createReturnCreditNote, applyCreditToOrder } from "@/app/admin/credit-notes/actions";
import type { OrderItem } from "@/lib/types";

// Returns and credit on the order page (11 Sep). Two controls, both live on a
// DELIVERED order — which is exactly when goods come back, so neither may be
// gated on the order still being editable.
//
// The dialog lists the whole bill because a return arrives as a parcel, and it
// prices the return the way the bill priced the sale: the bill's discount is
// allocated pro-rata and its own tax mode applied (computeCreditTotals). The
// preview is the same arithmetic the server will redo, shown before saving so
// the credited figure is never a surprise.

/** One line of order_bills.items — its index there is the stable address. */
export interface ReturnPanelLine {
  index: number;
  item: OrderItem;
  returned: number;
  /** Position in orders.items — display hint only; Modify Order re-packs it. */
  orderLineIndex: number | null;
}

interface ReturnDraft {
  qty: Record<string, number>;
  restock: Record<string, boolean>;
  reason: string;
  noteDate: string;
  // One idempotency key per dialog, not per click: a double-tap or a retried
  // request (including after a reload, which restores this draft) resolves to
  // the same credit note server-side. Re-minted only after a save lands.
  clientRef: string;
}

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function seed(lines: ReturnPanelLine[], focusIndex?: number): ReturnDraft {
  const qty: Record<string, number> = {};
  const restock: Record<string, boolean> = {};
  for (const l of lines) {
    const remaining = Math.max(0, l.item.qty - l.returned);
    qty[String(l.index)] = focusIndex === l.index ? remaining : 0;
    // A custom line has no catalog SKU — restocking it would mint stock for
    // the pseudo-SKU "CUSTOM" (the same guard both existing stock paths use).
    restock[String(l.index)] = !l.item.custom;
  }
  return { qty, restock, reason: "", noteDate: todayIst(), clientRef: crypto.randomUUID() };
}

const label = { fontSize: 8.5, letterSpacing: "0.14em", color: palette.mutedGreige } as const;
const field = {
  fontSize: 12, border: "1px solid rgba(26,26,26,0.25)", background: "#fff",
  color: palette.black, padding: "6px 8px",
} as const;

export function ReturnPanel({
  orderId, billId, billNumber, bill, lines, focusIndex,
}: {
  orderId: string;
  /** Null for an ORDER-anchored return (21 Sep) — the order's own invoice. */
  billId?: string | null;
  billNumber: string;
  bill: SourceBill;
  lines: ReturnPanelLine[];
  focusIndex?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ noteId: string; noteNumber: string; warning?: string } | null>(null);

  // Key is null while closed, so only the open dialog writes the draft (every
  // billed line of this bill mounts its own panel over the same return).
  const [draft, setDraft, draftMeta] = useDraft<ReturnDraft>(
    open ? `drevi:draft:credit-note:${orderId}:${billId ?? "order"}` : null,
    () => seed(lines, focusIndex),
    {
      hasContent: (d) => Object.values(d.qty).some((q) => q > 0) || d.reason.trim().length > 0,
      onRestore: (d) => ({ ...seed(lines, focusIndex), ...d }),
    },
  );
  const { qty, restock, reason, noteDate, clientRef } = draft;

  const picked = useMemo(
    () =>
      lines
        .filter((l) => (qty[String(l.index)] ?? 0) > 0)
        .map((l) => ({
          line: { item: l.item, index: l.index },
          qty: Math.min(qty[String(l.index)] ?? 0, Math.max(0, l.item.qty - l.returned)),
          restock: restock[String(l.index)] ?? false,
          orderLineIndex: l.orderLineIndex,
        })),
    [lines, qty, restock],
  );
  const totals = useMemo(() => computeCreditTotals(picked, bill), [picked, bill]);

  function setQty(index: number, next: number) {
    const line = lines.find((l) => l.index === index);
    const max = line ? Math.max(0, line.item.qty - line.returned) : 0;
    const clamped = Math.max(0, Math.min(max, Math.round(Number.isFinite(next) ? next : 0)));
    setDraft((d) => ({ ...d, qty: { ...d.qty, [String(index)]: clamped } }));
  }

  function save() {
    setError(null);
    if (picked.length === 0) { setError("Pick at least one line to return"); return; }
    if (!reason.trim()) { setError("A reason is required — it prints on the credit note"); return; }
    if (noteDate > todayIst()) { setError("A future note date is not allowed"); return; }
    start(async () => {
      const r = await createReturnCreditNote({
        orderId,
        orderBillId: billId ?? null,
        lines: picked.map((p) => ({ lineIndex: p.line.index, qty: p.qty, restock: p.restock })),
        reason: reason.trim(),
        noteDate,
        clientRef,
      });
      if (!r.ok) { setError(r.error ?? "Could not raise the credit note"); return; }
      setDone({ noteId: r.noteId ?? "", noteNumber: r.noteNumber ?? "", warning: r.warning });
      draftMeta.clear();
      setDraft(seed(lines));        // fresh idempotency key for the next return
      router.refresh();
    });
  }

  function close() {
    setOpen(false);
    setDone(null);
    setError(null);
  }

  if (!open) {
    return (
      <div className="mt-1.5">
        <button
          type="button"
          onClick={() => { setDone(null); setError(null); setOpen(true); }}
          className="flex items-center gap-1 font-body uppercase"
          style={{ fontSize: 8.5, letterSpacing: "0.08em", border: `1px solid ${palette.crimsonBorder}`, color: palette.crimsonText, padding: "3px 8px" }}
        >
          <Undo2 size={10} /> Return
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 p-3" style={{ background: palette.ivory, border: `1px solid ${palette.crimsonBorder}` }}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.crimsonText }}>
          Return against {billNumber}
        </div>
        <button type="button" onClick={close} aria-label="Close" style={{ color: palette.mutedGreige }}>
          <X size={14} />
        </button>
      </div>

      {done ? (
        <div className="mt-2">
          <div className="p-2.5" style={{ background: "rgba(31,107,69,0.1)", border: "1px solid rgba(31,107,69,0.35)" }}>
            <span className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: "#1F6B45" }}>
              {done.noteNumber} raised.
            </span>
            {done.noteId && (
              <a
                href={`/api/credit-notes/${done.noteId}/pdf`}
                target="_blank"
                rel="noreferrer"
                className="font-body uppercase ml-2"
                style={{ fontSize: 9.5, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}
              >
                Credit note PDF
              </a>
            )}
          </div>
          {/* Stock is posted after the note is safely written and is never
              rolled back — a failure here has to be read, not swallowed. */}
          {done.warning && (
            <div className="font-body mt-2 p-2.5" style={{ fontSize: 11.5, lineHeight: 1.6, background: palette.amberSoft, color: palette.goldDeep, border: `1px solid ${palette.gold}` }}>
              <b>Stock not fully posted</b> — {done.warning} Put the pieces back in Stock take.
            </div>
          )}
          <button type="button" onClick={close} className="font-body uppercase mt-2" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige, padding: "6px 2px" }}>
            Close
          </button>
        </div>
      ) : (
        <>
          <DraftNotice meta={draftMeta} label="Unsaved return restored" />

          {bill.discount_amount > 0 && (
            <div className="font-body mt-2" style={{ fontSize: 10.5, lineHeight: 1.5, color: palette.goldDeep }}>
              This bill carried a {formatINR(bill.discount_amount)} discount — the credit is each line&apos;s share of what was
              actually charged, not its list value.
            </div>
          )}

          <div className="mt-2" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
            {lines.map((l) => {
              const remaining = Math.max(0, l.item.qty - l.returned);
              const value = qty[String(l.index)] ?? 0;
              return (
                <div key={l.index} className="py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", opacity: remaining === 0 ? 0.5 : 1 }}>
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="font-display" style={{ fontSize: 12.5, color: palette.black, fontWeight: 500 }}>{l.item.title}</div>
                      <div className="font-body mt-0.5" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.1em" }}>
                        {l.item.custom ? "custom item" : l.item.sku} · billed {l.item.qty} × {formatUnitINR(l.item.unit_price)}
                        {l.returned > 0 ? ` · ${l.returned} returned` : ""}
                      </div>
                      {l.item.actual_qty != null && (
                        <div className="font-body mt-0.5" style={{ fontSize: 9.5, color: palette.goldDeep }}>
                          GST split — {l.item.actual_qty} physical pc billed as {l.item.qty} units. Enter BILLED units here.
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button type="button" disabled={value <= 0} onClick={() => setQty(l.index, value - 1)} aria-label="Less" className="disabled:opacity-30" style={{ border: "1px solid rgba(26,26,26,0.25)", color: palette.black, padding: "5px 6px" }}>
                        <Minus size={11} />
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={remaining}
                        value={value}
                        onChange={(e) => setQty(l.index, Number(e.target.value))}
                        className="font-body text-center"
                        style={{ ...field, width: 56 }}
                      />
                      <button type="button" disabled={value >= remaining} onClick={() => setQty(l.index, value + 1)} aria-label="More" className="disabled:opacity-30" style={{ border: "1px solid rgba(26,26,26,0.25)", color: palette.black, padding: "5px 6px" }}>
                        <Plus size={11} />
                      </button>
                      <span className="font-body uppercase" style={{ ...label, minWidth: 62 }}>of {remaining} left</span>
                    </div>
                  </div>
                  <label className="flex items-center gap-1.5 mt-1.5 font-body" style={{ fontSize: 10.5, color: l.item.custom ? palette.mutedGreige : palette.softBlack }}>
                    <input
                      type="checkbox"
                      checked={!!restock[String(l.index)] && !l.item.custom}
                      disabled={!!l.item.custom}
                      onChange={(e) => setDraft((d) => ({ ...d, restock: { ...d.restock, [String(l.index)]: e.target.checked } }))}
                    />
                    {l.item.custom ? "Custom line — not a catalog SKU, so it cannot go back into stock" : "Back into stock"}
                  </label>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex gap-2 flex-wrap items-end">
            <div className="flex-1" style={{ minWidth: 220 }}>
              <div className="font-body uppercase" style={label}>Reason (prints on the note)</div>
              <input
                value={reason}
                onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
                placeholder="Damaged · size exchange · goodwill"
                className="font-body mt-1 w-full"
                style={field}
              />
            </div>
            <div>
              <div className="font-body uppercase" style={label}>Note date</div>
              <input
                type="date"
                value={noteDate}
                max={todayIst()}
                onChange={(e) => setDraft((d) => ({ ...d, noteDate: e.target.value }))}
                className="font-body mt-1"
                style={field}
              />
            </div>
          </div>

          <div className="mt-3 p-2.5" style={{ background: palette.ivoryDeep }}>
            <div className="flex justify-between font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>
              <span>Goods returned{picked.length > 0 ? ` (${picked.length} line${picked.length === 1 ? "" : "s"})` : ""}</span>
              <span>{formatINR(totals.sourceSubtotal)}</span>
            </div>
            {totals.discountShare > 0 && (
              <div className="flex justify-between font-body mt-1" style={{ fontSize: 11.5, color: palette.goldDeep }}>
                <span>Share of the bill&apos;s discount</span><span>− {formatINR(totals.discountShare)}</span>
              </div>
            )}
            {totals.taxMode === "exclusive" && (
              <div className="flex justify-between font-body mt-1" style={{ fontSize: 11.5, color: palette.softBlack }}>
                <span>GST @ {totals.taxRate}% (added)</span><span>{formatINR(totals.taxAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-body mt-1.5" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>
              <span className="uppercase" style={{ letterSpacing: "0.12em", fontSize: 10.5 }}>Credit total</span>
              <span className="font-display" style={{ fontSize: 16 }}>{formatINR(totals.total)}</span>
            </div>
            {totals.taxMode === "inclusive" && (
              <div className="font-body text-right mt-0.5" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
                includes GST @ {totals.taxRate}% = {formatINR(totals.taxAmount)}
              </div>
            )}
          </div>

          {error && (
            <div className="font-body mt-2 p-2" style={{ fontSize: 11.5, background: palette.crimsonSoft, color: palette.crimsonText, border: `1px solid ${palette.crimsonBorder}` }}>
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button
              type="button"
              disabled={pending}
              onClick={save}
              className="font-body uppercase disabled:opacity-40"
              style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "9px 14px" }}
            >
              {pending ? "Raising…" : "Raise credit note"}
            </button>
            <button type="button" onClick={close} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.mutedGreige, padding: "9px 4px" }}>
              Cancel
            </button>
            <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
              The note is immutable once raised — void it if it is wrong.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Spend a party's wallet against this order. The amount is capped here at the
 * balance due, but the server re-reads the wallet under a per-party lock — the
 * cap on screen is a courtesy, never the guard.
 */
export function ApplyCreditBar({
  orderId, balance, maxApplicable,
}: {
  orderId: string;
  balance: number;
  maxApplicable: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(Math.max(0, Math.min(balance, maxApplicable))));
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function run() {
    setError(null);
    const v = validateCreditAmount(amount, Math.min(balance, maxApplicable));
    if (!v.ok) { setError(v.error); return; }
    start(async () => {
      const r = await applyCreditToOrder({ orderId, amount: v.value, clientRef });
      if (!r.ok) { setError(r.error ?? "Could not apply the credit"); return; }
      setOk(`Applied — ${formatINR(r.balance ?? 0)} of credit left`);
      setClientRef(crypto.randomUUID());   // a later application is its own write
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="mt-3 p-3" style={{ background: "rgba(196,163,90,0.1)", border: `1px solid ${palette.gold}` }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 font-body" style={{ fontSize: 12, color: palette.softBlack }}>
          <Wallet size={13} style={{ color: palette.goldDeep }} />
          <span><b>{formatINR(balance)}</b> credit in this party&apos;s wallet</span>
        </div>
        {!open ? (
          <button type="button" onClick={() => setOpen(true)} disabled={maxApplicable <= 0} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "9px 14px" }}>
            Apply credit
          </button>
        ) : (
          <div className="flex items-center gap-1.5 flex-wrap">
            <label className="font-body uppercase" style={label}>Amount</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="font-body"
              style={{ ...field, width: 110 }}
            />
            <button type="button" disabled={pending} onClick={run} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "9px 14px" }}>
              {pending ? "Applying…" : "Apply"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setError(null); }} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.mutedGreige, padding: "9px 4px" }}>
              Cancel
            </button>
          </div>
        )}
      </div>
      <div className="font-body mt-1" style={{ fontSize: 10, color: palette.mutedGreige }}>
        At most {formatINR(Math.min(balance, maxApplicable))} can go against this order — its balance due after the advance.
      </div>
      {error && <div className="font-body mt-1.5" style={{ fontSize: 11, color: palette.crimsonText, fontWeight: 600 }}>{error}</div>}
      {ok && !error && <div className="font-body mt-1.5" style={{ fontSize: 11, color: palette.goldDeep, fontWeight: 600 }}>{ok}</div>}
    </div>
  );
}

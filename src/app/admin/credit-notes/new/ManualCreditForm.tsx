"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { DraftNotice } from "@/components/DraftNotice";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { useDraft, isDraftOlderThan, DRAFT_NOTICE_AFTER_MS } from "@/lib/useDraft";
import { validateCreditAmount } from "@/lib/credit-core";
import { validateBillDate } from "@/lib/order-lines-core";
import { createManualCreditNote } from "../actions";

export interface PickerBuyer {
  id: string;
  name: string;
  sub: string;
  status: string;
}

// The note in flight, as one object so a half-filled form survives closing the
// app or a tab reload. clientRef rides along: a retried save after a reload
// still resolves to ONE credit note server-side (and one wallet grant with it).
interface FormState {
  buyerId: string;
  query: string;
  amount: string;
  reason: string;
  noteDate: string;
  clientRef: string;
}

const seed = (buyerId: string | null): FormState => ({
  buyerId: buyerId ?? "",
  query: "",
  amount: "",
  reason: "",
  noteDate: "",
  clientRef: crypto.randomUUID(),
});

const MAX_MATCHES = 8;

export function ManualCreditForm({ buyers, preselectBuyerId, todayIst }: { buyers: PickerBuyer[]; preselectBuyerId: string | null; todayIst: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ noteNumber: string; noteId: string } | null>(null);

  const [form, setForm, draftMeta] = useDraft<FormState>(`drevi:draft:credit-note:new:${preselectBuyerId ?? "any"}`, () => seed(preselectBuyerId), {
    hasContent: (d) => !!d.amount || !!d.reason || (!!d.buyerId && d.buyerId !== preselectBuyerId),
    onRestore: (d) => ({ ...seed(preselectBuyerId), ...d }),
  });
  const { buyerId, query, amount, reason, noteDate, clientRef } = form;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const byId = useMemo(() => new Map(buyers.map((b) => [b.id, b])), [buyers]);
  const chosen = buyerId ? byId.get(buyerId) ?? null : null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return buyers.filter((b) => `${b.name} ${b.sub}`.toLowerCase().includes(q)).slice(0, MAX_MATCHES);
  }, [buyers, query]);

  const amountCheck = amount.trim() ? validateCreditAmount(amount) : null;
  const dateOk = !noteDate || validateBillDate(noteDate, todayIst) !== null;
  const canSave = !!chosen && !!amountCheck && amountCheck.ok && reason.trim().length > 0 && dateOk;

  function save() {
    setError(null);
    if (!chosen) { setError("Pick the party this credit belongs to"); return; }
    const amt = validateCreditAmount(amount);
    if (!amt.ok) { setError(amt.error); return; }
    if (!reason.trim()) { setError("Say why this credit is being given — it prints on the note"); return; }
    const day = noteDate ? validateBillDate(noteDate, todayIst) : todayIst;
    if (!day) { setError("That note date isn't valid — no future dates"); return; }

    start(async () => {
      // The server recomputes and re-validates everything; clientRef is what
      // makes a double-tap or a retried request resolve to one note.
      const r = await createManualCreditNote({ buyerId: chosen.id, amount: amt.value, reason: reason.trim(), noteDate: day, clientRef });
      if (!r.ok) { setError(r.error ?? "Could not issue the credit note"); return; }
      setSaved({ noteNumber: r.noteNumber ?? "Credit note", noteId: r.noteId ?? "" });
      draftMeta.clear();
      setForm(seed(preselectBuyerId));
      router.refresh();
    });
  }

  const labelStyle = { fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack } as const;
  const fieldStyle = { borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13.5 } as const;

  return (
    <div className="mt-6">
      {saved && (
        <div className="p-3 mb-4 flex items-center justify-between gap-2 flex-wrap" style={{ background: "rgba(31,107,69,0.1)", border: "1px solid rgba(31,107,69,0.35)" }}>
          <span className="font-body" style={{ fontSize: 12.5, color: "#1F6B45", fontWeight: 600 }}>
            {saved.noteNumber} issued — the credit is in the party&rsquo;s wallet.
          </span>
          <span className="flex items-center gap-3">
            {saved.noteId && (
              <a href={`/api/credit-notes/${saved.noteId}/pdf`} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>Open PDF</a>
            )}
            <Link href="/admin/credit-notes" className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>Register</Link>
            <button type="button" onClick={() => setSaved(null)} aria-label="Dismiss"><X size={14} color={palette.mutedGreige} /></button>
          </span>
        </div>
      )}

      {isDraftOlderThan(draftMeta, DRAFT_NOTICE_AFTER_MS) && <div className="mb-4"><DraftNotice meta={draftMeta} /></div>}

      {/* Party */}
      <div className="flex flex-col gap-1">
        <span className="font-body uppercase" style={labelStyle}>Party</span>
        {chosen ? (
          <div className="flex items-center justify-between gap-2 flex-wrap" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "9px 11px", background: palette.ivoryDeep }}>
            <span className="min-w-0">
              <span className="font-display block" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{chosen.name}</span>
              <span className="font-body block" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                {chosen.sub}{chosen.status !== "active" ? ` · ${chosen.status}` : ""}
              </span>
            </span>
            <button type="button" onClick={() => { set("buyerId", ""); set("query", ""); }} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.goldDeep, textDecoration: "underline" }}>
              Change
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px", background: "#fff" }}>
              <Search size={14} color={palette.mutedGreige} />
              <input
                value={query}
                onChange={(e) => set("query", e.target.value)}
                placeholder="Search business, owner, city or phone"
                className="font-body flex-1 bg-transparent outline-none"
                style={{ fontSize: 12.5, color: palette.black }}
              />
              {query && <button type="button" onClick={() => set("query", "")} aria-label="Clear"><X size={13} color={palette.mutedGreige} /></button>}
            </div>
            {query.trim() && (
              matches.length === 0 ? (
                <p className="font-body mt-1" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No party matches — check Buyers, or add them there first.</p>
              ) : (
                <div className="mt-1" style={{ border: "1px solid rgba(26,26,26,0.12)" }}>
                  {matches.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => { set("buyerId", b.id); set("query", ""); }}
                      className="w-full text-left"
                      style={{ padding: "8px 11px", borderBottom: "1px solid rgba(26,26,26,0.07)", background: "transparent" }}
                    >
                      <span className="font-body block" style={{ fontSize: 12.5, color: palette.black }}>{b.name}</span>
                      <span className="font-body block" style={{ fontSize: 10, color: palette.mutedGreige }}>
                        {b.sub}{b.status !== "active" ? ` · ${b.status}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )
            )}
          </>
        )}
      </div>

      {/* Amount */}
      <label className="flex flex-col gap-1 mt-5">
        <span className="font-body uppercase" style={labelStyle}>Credit amount (₹)</span>
        <input
          value={amount}
          onChange={(e) => set("amount", e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="font-body bg-transparent outline-none"
          style={fieldStyle}
        />
        {amountCheck && (amountCheck.ok
          ? <span className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>{formatINR(amountCheck.value)}</span>
          : <span className="font-body" style={{ fontSize: 10.5, color: palette.crimsonText }}>{amountCheck.error}</span>
        )}
      </label>

      {/* Reason */}
      <label className="flex flex-col gap-1 mt-5">
        <span className="font-body uppercase" style={labelStyle}>Reason</span>
        <textarea
          value={reason}
          onChange={(e) => set("reason", e.target.value)}
          rows={2}
          placeholder="Goodwill on the damaged lehenga · settlement agreed with Rakesh"
          className="w-full font-body bg-transparent outline-none"
          style={{ border: "1px solid rgba(26,26,26,0.2)", padding: 8, fontSize: 12.5 }}
        />
        <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>Prints on the credit note the party receives.</span>
      </label>

      {/* Date */}
      <label className="flex flex-col gap-1 mt-5 max-w-xs">
        <span className="font-body uppercase" style={labelStyle}>Note date</span>
        <input
          type="date"
          value={noteDate}
          max={todayIst}
          onChange={(e) => set("noteDate", e.target.value)}
          className="font-body bg-transparent outline-none"
          style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 8px", fontSize: 12.5 }}
        />
        <span className="font-body" style={{ fontSize: 10, color: dateOk ? palette.mutedGreige : palette.crimsonText }}>
          {dateOk ? "Blank means today. Past dates allowed, future dates are not." : "Not a valid past date."}
        </span>
      </label>

      {error && (
        <p className="font-body mt-4" style={{ fontSize: 12, color: palette.crimsonText }}>{error}</p>
      )}

      <div className="flex gap-2 mt-6">
        <button
          type="button"
          onClick={save}
          disabled={pending || !canSave}
          className="font-body uppercase disabled:opacity-40"
          style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 22px" }}
        >
          {pending ? "Issuing…" : "Issue Credit Note"}
        </button>
        <Link href="/admin/credit-notes" className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.16em", padding: "12px 18px" }}>
          Cancel
        </Link>
      </div>
    </div>
  );
}

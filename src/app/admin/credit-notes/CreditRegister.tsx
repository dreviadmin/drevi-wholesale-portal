"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { withFrom } from "@/components/BackLink";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { ConfirmSheet } from "@/components/admin/ConfirmSheet";
import { voidCreditNote } from "./actions";

export interface CreditRegisterRow {
  id: string;
  number: string;
  kind: string;
  date: string;            // note_date, a DATE column
  party: string | null;
  buyerId: string | null;
  against: string | null;  // source bill number, else the order number
  orderId: string | null;
  reason: string;
  total: number;
  consumed: number;
  remaining: number;
  status: string;
}

const ACC: Record<string, SortAccessor<CreditRegisterRow>> = {
  number: (r) => r.number,
  date: (r) => r.date,
  party: (r) => r.party,
  against: (r) => r.against,
  total: (r) => r.total,
  consumed: (r) => r.consumed,
  remaining: (r) => r.remaining,
  status: (r) => r.status,
};

const HERE = "/admin/credit-notes";

// note_date is a DATE — pinned to IST noon so a device behind UTC doesn't
// render the day before.
function fmtDay(day: string) {
  return new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function CreditRegister({ rows, query }: { rows: CreditRegisterRow[]; query: string }) {
  const sort = useSort(rows, ACC, { key: "date", dir: "desc" });
  // A void whose stock compensation failed still succeeded as a void — the
  // warning is hoisted here so it survives the row re-rendering as voided.
  const [notice, setNotice] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <p className="font-body mt-5" style={{ fontSize: 12, color: palette.mutedGreige }}>
        No credit notes{query ? " match that search." : " yet — raise one from a billed order line, or issue a manual credit."}
      </p>
    );
  }

  const td = (content: React.ReactNode, right = false, bold = false) => (
    <td className={bold ? "font-display" : "font-body"} style={{ fontSize: bold ? 13 : 12, fontWeight: bold ? 600 : 400, color: palette.black, textAlign: right ? "right" : "left", padding: "8px", whiteSpace: "nowrap" }}>{content}</td>
  );

  return (
    <div className="mt-3">
      {notice && (
        <div className="p-3 mb-3 flex items-center justify-between gap-2 flex-wrap" style={{ background: palette.amberSoft, border: `1px solid ${palette.gold}` }}>
          <span className="font-body" style={{ fontSize: 12, color: palette.goldDeep, fontWeight: 600 }}>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.mutedGreige }}>Dismiss</button>
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full" style={{ borderCollapse: "collapse" }}>
        <thead><tr style={{ borderBottom: `1px solid ${palette.black}` }}>
          <SortTh label="Note" k="number" sort={sort.sort} onToggle={sort.toggle} />
          <SortTh label="Date" k="date" sort={sort.sort} onToggle={sort.toggle} defaultDir="desc" />
          <SortTh label="Party" k="party" sort={sort.sort} onToggle={sort.toggle} />
          <SortTh label="Against" k="against" sort={sort.sort} onToggle={sort.toggle} />
          <SortTh label="Amount" k="total" sort={sort.sort} onToggle={sort.toggle} right defaultDir="desc" />
          <SortTh label="Used" k="consumed" sort={sort.sort} onToggle={sort.toggle} right defaultDir="desc" />
          <SortTh label="Left" k="remaining" sort={sort.sort} onToggle={sort.toggle} right defaultDir="desc" />
          <SortTh label="Status" k="status" sort={sort.sort} onToggle={sort.toggle} />
          <th />
        </tr></thead>
        <tbody>
          {sort.sorted.map((r) => {
            const voided = r.status !== "issued";
            return (
              <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.07)", opacity: voided ? 0.55 : 1 }}>
                {td(
                  <>
                    <span className="font-display" style={{ fontSize: 13, fontWeight: 500 }}>{r.number}</span><br />
                    <span style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.06em" }}>
                      {r.kind === "return" ? "RETURN" : "MANUAL"}
                    </span>
                  </>,
                )}
                {td(fmtDay(r.date))}
                {td(
                  r.buyerId
                    ? <Link href={withFrom(`/admin/buyers/${r.buyerId}`, HERE)} style={{ borderBottom: `1px solid ${palette.gold}` }}>{r.party ?? "Unknown party"}</Link>
                    : <span style={{ color: palette.mutedGreige }}>—</span>,
                )}
                {td(
                  r.against
                    ? (r.orderId
                        ? <Link href={withFrom(`/admin/orders/${r.orderId}`, HERE)} style={{ borderBottom: `1px solid ${palette.gold}` }}>{r.against}</Link>
                        : r.against)
                    : <span style={{ color: palette.mutedGreige }} title={r.reason}>—</span>,
                )}
                {td(formatINR(r.total), true, true)}
                {td(voided ? <span style={{ color: palette.mutedGreige }}>—</span> : formatINR(r.consumed), true)}
                {td(
                  voided
                    ? <span style={{ color: palette.mutedGreige }}>—</span>
                    : <span style={{ color: r.remaining > 0 ? palette.goldDeep : palette.mutedGreige }}>{formatINR(r.remaining)}</span>,
                  true,
                )}
                {td(
                  voided
                    ? <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.crimsonText }}>VOID</span>
                    : <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige }}>ISSUED</span>,
                )}
                <td style={{ padding: "8px", textAlign: "right", whiteSpace: "nowrap" }}>
                  <span className="inline-flex items-center gap-3">
                    <a href={`/api/credit-notes/${r.id}/pdf`} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>PDF</a>
                    {!voided && <VoidNoteButton noteId={r.id} noteNumber={r.number} consumed={r.consumed} onNotice={setNotice} />}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** Void through the confirm sheet, a reason required — the credit comes back
 *  out of the party's wallet, the note and its number stay on record as voided.
 *  The outcome is hoisted (onNotice): the row re-renders as voided and this
 *  button goes with it. */
function VoidNoteButton({ noteId, noteNumber, consumed, onNotice }: { noteId: string; noteNumber: string; consumed: number; onNotice: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function submit(reason: string) {
    if (!reason) { setErr("A reason is required"); return; }
    setErr(null);
    start(async () => {
      const r = await voidCreditNote(noteId, reason);
      if (!r.ok) { setErr(r.error ?? "Failed"); return; }
      onNotice(r.warning ? `${noteNumber} voided. ${r.warning}` : `${noteNumber} voided.`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setErr(null); setOpen(true); }}
        className="font-body uppercase"
        style={{ fontSize: 11, letterSpacing: "0.1em", color: palette.crimsonText, minHeight: 44, padding: "0 6px" }}
        title={`Void ${noteNumber} — the credit leaves the wallet, the note stays on record`}
      >
        Void
      </button>
      {open && (
        <ConfirmSheet
          title={`Void ${noteNumber}`}
          confirmLabel="Void credit note"
          pendingLabel="Voiding…"
          reasonPlaceholder={`Why is ${noteNumber} being voided?`}
          pending={pending}
          error={err}
          onConfirm={submit}
          onClose={() => setOpen(false)}
        >
          {consumed > 0 && (
            <p style={{ color: palette.crimsonText, marginBottom: 8 }}>
              {formatINR(consumed)} of {noteNumber} has already been spent — undo those applications first if this void is refused.
            </p>
          )}
          <p>The credit comes back out of the party&apos;s wallet. The note and its number stay on record as voided, with the reason below.</p>
        </ConfirmSheet>
      )}
    </>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { setBillDate, setOrderDate } from "@/app/admin/orders/actions";
import { palette } from "@/lib/palette";

// Ansh (14 Sep) — the companion to back-dated entry (18 Aug). Entry records the
// day a sale actually happened; this is the way back when that day was recorded
// wrong. It is deliberately two different conversations, because the two
// documents are not symmetric:
//
//   · a BILL number carries no date, so re-dating one is a plain correction —
//     the stored PDF is re-rendered and the credit notes that quote the date
//     follow it;
//   · an ORDER number encodes its day (DX-20260717-014), is issued gaplessly,
//     and is already printed on PDFs the buyer holds, so it cannot be reissued.
//     The order moves and its number stays behind. That mismatch is permanent,
//     so the dialog leads with it rather than mentioning it afterwards.

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const longDate = (ymd: string) =>
  new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** The day baked into a document number (XX-YYYYMMDD-NNN), when it has one. */
function numberDay(documentNumber: string): string | null {
  const m = documentNumber.match(/^[A-Za-z]+-(\d{4})(\d{2})(\d{2})-\d+/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function DateCorrection({
  kind,
  targetId,
  documentNumber,
  currentDate,
  floorDate,
  ceilingDate,
}: {
  kind: "order" | "bill";
  targetId: string;
  documentNumber: string;
  /** The date as it stands, YYYY-MM-DD — for an order, its IST day. */
  currentDate: string;
  /** Earliest the server will accept — a bill may not predate its own order. */
  floorDate?: string | null;
  /** Latest the server will accept — an order may not start after its first bill. */
  ceilingDate?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(currentDate);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 3500); }

  function close() { setOpen(false); setDate(currentDate); setReason(""); setError(null); }

  function submit() {
    setError(null);
    start(async () => {
      const res = kind === "bill"
        ? await setBillDate(targetId, date, reason)
        : await setOrderDate(targetId, date, reason);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setOpen(false);
      setReason("");
      flash(`${documentNumber} now dated ${longDate(date)} · recorded in the audit trail`);
      router.refresh();
    });
  }

  // Only an order number states a day, so only an order dialog can name the one
  // it is about to contradict.
  const stampedDay = kind === "order" ? numberDay(documentNumber) : null;
  const today = todayIst();
  const max = ceilingDate && ceilingDate < today ? ceilingDate : today;

  return (
    <>
      <button
        type="button"
        onClick={() => { setDate(currentDate); setError(null); setOpen(true); }}
        aria-label={`Correct the date on ${documentNumber}`}
        title={kind === "order"
          ? "Correct this order's date — the order number itself cannot be reissued"
          : "Correct this bill's date — the PDF is re-rendered"}
        className="inline-flex items-center gap-1 font-body uppercase align-middle"
        style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.goldDeep }}
      >
        <CalendarClock size={11} /> Correct date
      </button>
      {toast && <span className="font-body ml-2" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.04em" }}>{toast}</span>}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !pending && close()}>
          <div className="w-full sm:max-w-md max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>
              {kind === "order" ? "Correct this order's date" : "Correct this bill's date"}
            </h2>

            {kind === "order" ? (
              <div className="font-body mt-2 p-2.5" style={{ fontSize: 11.5, lineHeight: 1.7, background: palette.crimsonSoft, color: palette.crimsonText, border: `1px solid ${palette.crimsonBorder}` }}>
                <b>{documentNumber} keeps its number.</b> The number encodes
                {stampedDay ? ` ${longDate(stampedDay)}` : " the day it was issued"}, the series is gapless, and it is already printed on the PDFs this buyer holds — it cannot be reissued. After this the order carries a date its own number does not state.
                <br />
                Moving the order across an IST day also moves it between dashboard and report buckets, which bucket on the order&apos;s date and not on its number.
              </div>
            ) : (
              <div className="font-body mt-2 p-2.5" style={{ fontSize: 11.5, lineHeight: 1.7, background: palette.amberSoft, color: palette.goldDeep, border: `1px solid ${palette.gold}` }}>
                A bill number encodes no date, so {documentNumber} keeps its number and only changes the date it states. The stored PDF is re-rendered, and any credit note raised against this bill is re-referenced to the new date.
                {floorDate ? ` It cannot move before ${longDate(floorDate)}, the day its order was placed.` : ""}
              </div>
            )}

            <label className="flex flex-col gap-1 mt-4">
              <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>
                {kind === "order" ? "Order date" : "Bill date"}
              </span>
              <input
                type="date"
                value={date}
                min={floorDate ?? undefined}
                max={max}
                onChange={(e) => setDate(e.target.value)}
                className="font-body"
                style={{ fontSize: 12.5, border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black, padding: "8px 10px" }}
              />
              <span className="font-body" style={{ fontSize: 10, lineHeight: 1.5, color: palette.mutedGreige }}>
                Currently {longDate(currentDate)}. Today or earlier only.
                {ceilingDate ? ` No later than ${longDate(ceilingDate)} — the first bill raised against this order.` : ""}
              </span>
            </label>

            {/* The action refuses an empty reason: it lands in the audit note
                beside the old and new date, so it has to say what was wrong. */}
            <label className="flex flex-col gap-1 mt-4">
              <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>Reason (required)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={300}
                placeholder="Why the recorded date was wrong"
                className="font-body bg-transparent outline-none resize-none"
                style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 12.5 }}
              />
              <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>Recorded in the audit trail with the old date, the new date and this reason.</span>
            </label>

            {error && <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.crimsonText }}>{error}</p>}
            <div className="flex gap-2 mt-5">
              <button
                type="button"
                onClick={submit}
                disabled={pending || !reason.trim() || date === currentDate}
                className="flex-1 font-body uppercase disabled:opacity-50"
                style={{ background: kind === "order" ? palette.crimsonText : palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 0" }}
              >
                {pending ? "Saving…" : `Re-date ${documentNumber}`}
              </button>
              <button type="button" onClick={close} disabled={pending} className="font-body uppercase px-5" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

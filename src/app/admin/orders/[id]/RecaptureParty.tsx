"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileWarning } from "lucide-react";
import { recaptureDocumentParty } from "@/app/admin/orders/actions";
import { palette } from "@/lib/palette";

// Ansh (13 Sep) — the way back from a party recorded wrong. 0047 froze the
// recipient onto the order and its bills at issue, so Edit Details no longer
// reaches a document that has already gone out. This re-stamps THIS order and
// its bills from the corrected buyers row and re-renders their PDFs. Kept
// apart from Edit on purpose: it rewrites what a tax document says it was
// issued to, and the audit trail records it as a correction, not an edit.

/** Mirrors BuyerParty, which is server-only and so can't be imported here. */
export interface PartyFields {
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
  gstin: string | null;
  address: string | null;
}

// Same order the audit note reads the fields out in.
const FIELDS: [keyof PartyFields, string][] = [
  ["business_name", "Business"],
  ["owner_name", "Owner"],
  ["phone", "Phone"],
  ["city", "City"],
  ["gstin", "GSTIN"],
  ["address", "Address"],
];

function shown(v: string | null) { return v && v.trim() ? v : "(empty)"; }

export function RecaptureParty({
  orderId,
  orderNumber,
  billCount,
  creditNoteCount,
  printed,
  current,
}: {
  orderId: string;
  orderNumber: string;
  billCount: number;
  creditNoteCount: number;
  /** What these documents print today — resolveDocumentParty, not the buyers row. */
  printed: PartyFields;
  /** The buyers row as it stands now, which is exactly what a re-stamp would print. */
  current: PartyFields;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 3500); }

  // The buyers row is what would be stamped, so this diff is the whole
  // preview: these lines are what the documents will say afterwards.
  const changing = FIELDS.filter(([k]) => (printed[k] ?? "") !== (current[k] ?? ""));
  const documents = billCount > 0
    ? `${orderNumber} and its ${billCount} bill${billCount === 1 ? "" : "s"}`
    : orderNumber;

  function close() { setOpen(false); setReason(""); setError(null); }

  function submit() {
    setError(null);
    start(async () => {
      const res = await recaptureDocumentParty(orderId, reason);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      const bills = res.bills ?? 0;
      close();
      flash(`Party re-stamped on ${orderNumber}${bills > 0 ? ` and ${bills} bill${bills === 1 ? "" : "s"}` : ""} · recorded in the audit trail`);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Correct the party printed on this order's documents"
        title={`Correct the party ${documents} were issued to — the PDFs are re-rendered`}
        className="inline-flex items-center gap-1 font-body uppercase align-middle"
        style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.crimsonText }}
      >
        <FileWarning size={11} /> Correct party
      </button>
      {toast && <span className="font-body ml-2" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.04em" }}>{toast}</span>}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !pending && close()}>
          <div className="w-full sm:max-w-md max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>Correct the party on issued documents</h2>
            <div className="font-body mt-2 p-2.5" style={{ fontSize: 11.5, lineHeight: 1.7, background: palette.crimsonSoft, color: palette.crimsonText, border: `1px solid ${palette.crimsonBorder}` }}>
              {documents} already state who they were issued to. This replaces that party with the buyers row as it stands now and re-renders the files in place.
              {creditNoteCount > 0 && " Credit notes on this order keep the party they were raised with."}
              {" "}The buyer is not re-notified, so share the corrected invoice yourself.
              <br />
              Use it only for a party recorded wrong. A party that genuinely changed belongs on the next document, not on this one.
            </div>

            <div className="mt-3">
              <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>What the documents will say</div>
              {changing.length === 0 ? (
                <p className="font-body mt-1.5" style={{ fontSize: 11.5, lineHeight: 1.6, color: palette.softBlack }}>
                  Nothing differs — the buyers row already matches what these documents print. Correct the buyer with Edit first, or re-stamp unchanged to freeze this party onto them.
                </p>
              ) : (
                <div className="flex flex-col gap-2 mt-1.5">
                  {changing.map(([key, label]) => (
                    <div key={key} className="font-body" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                      <span className="uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>{label}</span>
                      <div style={{ color: palette.mutedGreige, textDecoration: "line-through" }}>{shown(printed[key])}</div>
                      <div style={{ color: palette.black, fontWeight: 600 }}>{shown(current[key])}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* The action refuses an empty reason — it lands in the audit note
                next to the before/after, so it has to say what was wrong. */}
            <label className="flex flex-col gap-1 mt-4">
              <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>Reason (required)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={300}
                placeholder="What was wrong with the party on this document"
                className="font-body bg-transparent outline-none resize-none"
                style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 12.5 }}
              />
              <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>Recorded against the buyer as a document correction, with the fields it replaced.</span>
            </label>

            {error && <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.crimsonText }}>{error}</p>}
            <div className="flex gap-2 mt-5">
              <button type="button" onClick={submit} disabled={pending || !reason.trim()} className="flex-1 font-body uppercase disabled:opacity-50" style={{ background: palette.crimsonText, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 0" }}>
                {pending ? "Re-stamping…" : `Re-stamp ${documents}`}
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

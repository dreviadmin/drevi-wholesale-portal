"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { updateBuyerProfile } from "@/app/admin/buyers/actions";
import { DraftNotice } from "@/components/DraftNotice";
import { palette } from "@/lib/palette";
import { useDraft } from "@/lib/useDraft";

// Ansh (30 Jul) — buyer details editable right from the order page: phone
// taken down wrong at the booth, GSTIN missing for the invoice, address for
// dispatch. Reuses the buyers-section action; changes apply to the buyer
// everywhere, not just this order.

export interface BuyerEditFields {
  business_name: string;
  owner_name: string;
  phone: string;
  city: string;
  gstin: string;
  address: string;
  transport_details: string;
  broker_details: string;
}

const FIELDS: [keyof BuyerEditFields, string][] = [
  ["business_name", "Business name"],
  ["owner_name", "Owner name"],
  ["phone", "Phone"],
  ["city", "City"],
  ["gstin", "GSTIN"],
  ["address", "Address"],
  ["transport_details", "Transport"],
  ["broker_details", "Broker"],
];

// One draft per buyer, shared with admin/buyers/[id]/BuyerDetail so an edit
// started on either surface resumes on both. The stale check compares the
// server signature, so both surfaces must derive it from the same fields —
// the eight seeded here (BuyerDetail alone also edits other_details).
export const buyerEditDraftKey = (buyerId: string) => `drevi:draft:buyer-edit:${buyerId}`;
export function buyerEditSignature(f: BuyerEditFields): string {
  return JSON.stringify(FIELDS.map(([k]) => f[k]));
}

export function EditBuyerButton({ buyerId, initial }: { buyerId: string; initial: BuyerEditFields }) {
  const router = useRouter();
  const [draft, setDraft, draftMeta] = useDraft<{ open: boolean; form: BuyerEditFields }>(
    buyerEditDraftKey(buyerId),
    { open: false, form: initial },
    {
      hasContent: (d) => d.open,
      base: buyerEditSignature(initial),
      onRestore: (d) => ({ ...d, form: { ...initial, ...d.form } }),
    },
  );
  const { open, form } = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openEdit() {
    setDraft((d) => (draftMeta.restored ? { ...d, open: true } : { open: true, form: initial }));
  }
  function close() {
    draftMeta.clear();
    setDraft({ open: false, form: initial });
  }
  // Discard / Use server keep the modal open on the current server values.
  const notice = { ...draftMeta, discard: () => { draftMeta.clear(); setDraft({ open: true, form: initial }); } };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await updateBuyerProfile(buyerId, form);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openEdit}
        aria-label="Edit buyer details"
        className="inline-flex items-center gap-1 font-body uppercase align-middle"
        style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.goldDeep }}
      >
        <Pencil size={11} /> Edit
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !busy && close()}>
          <div className="w-full sm:max-w-md max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>Edit Buyer</h2>
            <p className="font-body mt-1" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
              Changes apply to this buyer everywhere — not just this order.
            </p>
            {draftMeta.restored && <div className="mt-3"><DraftNotice meta={notice} /></div>}
            <div className="flex flex-col gap-3 mt-4">
              {FIELDS.map(([key, label]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>{label}</span>
                  <input
                    value={form[key]}
                    onChange={(e) => setDraft((d) => ({ ...d, form: { ...d.form, [key]: e.target.value } }))}
                    className="font-body bg-transparent outline-none"
                    style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13.5 }}
                  />
                </label>
              ))}
            </div>
            {error && <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.crimsonText }}>{error}</p>}
            <div className="flex gap-2 mt-5">
              <button type="button" onClick={save} disabled={busy} className="flex-1 font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 0" }}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={close} disabled={busy} className="font-body uppercase px-5" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

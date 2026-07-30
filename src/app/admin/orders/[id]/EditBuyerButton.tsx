"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { updateBuyerProfile } from "@/app/admin/buyers/actions";
import { palette } from "@/lib/palette";

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

export function EditBuyerButton({ buyerId, initial }: { buyerId: string; initial: BuyerEditFields }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await updateBuyerProfile(buyerId, form);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Edit buyer details"
        className="inline-flex items-center gap-1 font-body uppercase align-middle"
        style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.goldDeep }}
      >
        <Pencil size={11} /> Edit
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !busy && setOpen(false)}>
          <div className="w-full sm:max-w-md max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>Edit Buyer</h2>
            <p className="font-body mt-1" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
              Changes apply to this buyer everywhere — not just this order.
            </p>
            <div className="flex flex-col gap-3 mt-4">
              {FIELDS.map(([key, label]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>{label}</span>
                  <input
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
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
              <button type="button" onClick={() => setOpen(false)} disabled={busy} className="font-body uppercase px-5" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

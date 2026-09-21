"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BackLink } from "@/components/BackLink";
import { DraftNotice } from "@/components/DraftNotice";
import { useDraft, isDraftOlderThan, DRAFT_NOTICE_AFTER_MS } from "@/lib/useDraft";
import { addBuyer, uploadBuyerCard } from "@/app/admin/buyers/actions";
import { uuid } from "@/lib/uuid";
import { CredentialModal } from "@/components/admin/CredentialModal";
import { PhoneInput } from "@/components/PhoneInput";
import { palette } from "@/lib/palette";
import { downscalePhoto } from "@/lib/downscale-photo";

const EMPTY = {
  business_name: "", owner_name: "", email: "", phone: "", city: "", gstin: "",
  address: "", transport_details: "", broker_details: "", other_details: "", notes: "",
  category: "", website: "", instagram: "", facebook: "", email_alt: "",
};

// What a person capturing a buyer at a counter actually types. Everything else
// is real but rarely known in the moment, so it sits behind one disclosure
// rather than making the common case scroll (Ansh, 21 Sep: "while manual entry
// show only the required fields (minimal like right now), make other fields in
// a collapsible window").

// Case B — manual add. Most fields are optional; the credential modal opens
// immediately so Rakesh can activate on the spot when ready.
export default function AddBuyerPage() {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; email: string; owner_name: string; business_name: string; phone: string } | null>(null);
  // Draft autosave — a half-filled form survives closing the app / navigating
  // away. Cleared on successful create. (The photo can't be drafted.)
  const [f, setF, draft] = useDraft("drevi:draft:add-buyer", EMPTY, {
    hasContent: (d) => Object.values(d).some((v) => v.trim() !== ""),
    onRestore: (d) => ({ ...EMPTY, ...d }),
  });
  const [cardFile, setCardFile] = useState<File | null>(null);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  // One idempotency key per form fill — flaky-wifi retries of Save resolve
  // to the same buyer row (audit fix).
  const clientRefRef = useRef<string | null>(null);
  const cardCameraRef = useRef<HTMLInputElement>(null);
  const cardGalleryRef = useRef<HTMLInputElement>(null);

  function save() {
    setError(null);
    start(async () => {
      const res = await addBuyer({ ...f, clientRef: clientRefRef.current ?? (clientRefRef.current = uuid()) });
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      if (cardFile) {
        const fd = new FormData();
        fd.append("card", await downscalePhoto(cardFile));
        await uploadBuyerCard(res.id!, fd); // best-effort; buyer exists either way
      }
      draft.clear();
      setCreated({ id: res.id!, email: f.email.trim().toLowerCase(), owner_name: f.owner_name, business_name: f.business_name, phone: f.phone });
    });
  }

  const labelCls = "font-body uppercase";
  const labelStyle = { fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack };
  const inputStyle = { borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "7px 2px", fontSize: 13 };

  const field = (label: string, key: keyof typeof EMPTY, required = false, type = "text") => (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls} style={labelStyle}>{label}{required ? " *" : ""}</span>
      <input type={type} value={f[key]} onChange={set(key)} className="font-body bg-transparent outline-none" style={inputStyle} />
    </label>
  );
  const area = (label: string, key: keyof typeof EMPTY) => (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls} style={labelStyle}>{label}</span>
      <textarea rows={2} value={f[key]} onChange={set(key)} className="font-body bg-transparent outline-none resize-none" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "8px 10px", fontSize: 13 }} />
    </label>
  );

  return (
    <div className="px-4 md:px-8 py-6 max-w-md">
      <BackLink fallback="/admin/buyers" fallbackLabel="Buyers" />
      <h1 className="font-display mt-3" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Add Buyer</h1>
      <p className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige }}>Fill what you have. Email becomes required at credential activation.</p>
      {isDraftOlderThan(draft, DRAFT_NOTICE_AFTER_MS) && <div className="mt-3"><DraftNotice meta={draft} /></div>}

      <div className="mt-5 flex flex-col gap-4">
        {field("Business name", "business_name")}
        {field("Owner name", "owner_name", true)}
        {field("Email", "email", false, "email")}
        <PhoneInput value={f.phone} onChange={(v) => setF({ ...f, phone: v })} required />
        {field("City", "city")}
        {field("GSTIN", "gstin")}

        <details style={{ borderTop: "1px solid rgba(26,26,26,0.12)", paddingTop: 14 }}>
          <summary className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.16em", color: palette.mutedGreige, cursor: "pointer", listStyle: "revert" }}>
            More details — address, trade, socials
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {field("Products / category", "category")}
            {area("Address", "address")}
            {field("Website", "website")}
            {field("Instagram", "instagram")}
            {field("Facebook", "facebook")}
            {field("Alternate email", "email_alt", false, "email")}
            {area("Transport details", "transport_details")}
            {area("Broker details", "broker_details")}
            {area("Other details", "other_details")}
            {area("Notes", "notes")}
          </div>
        </details>
        <div className="flex flex-col gap-1.5">
          <span className={labelCls} style={labelStyle}>Visiting card / photo</span>
          <input ref={cardCameraRef} type="file" accept="image/*" capture="environment" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) setCardFile(f); e.currentTarget.value = ""; }} />
          <input ref={cardGalleryRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) setCardFile(f); e.currentTarget.value = ""; }} />
          <div className="flex gap-2">
            <button type="button" onClick={() => cardCameraRef.current?.click()} className="flex-1 font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 9.5, letterSpacing: "0.14em", padding: "10px 0" }}>
              Camera
            </button>
            <button type="button" onClick={() => cardGalleryRef.current?.click()} className="flex-1 font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 9.5, letterSpacing: "0.14em", padding: "10px 0" }}>
              Gallery
            </button>
          </div>
          {cardFile && <span className="font-body" style={{ fontSize: 10, color: palette.goldDeep }}>{cardFile.name} ({Math.round(cardFile.size / 1024)} KB)</span>}
        </div>
        {error && <p className="font-body" style={{ fontSize: 11, color: palette.crimsonText }}>{error}</p>}
        <button type="button" onClick={save} disabled={isPending} className="font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "12px 0" }}>
          {isPending ? "Saving…" : "Save & Set Credentials"}
        </button>
      </div>

      {created && (
        <CredentialModal
          buyerId={created.id}
          buyer={{ email: created.email, owner_name: created.owner_name, business_name: created.business_name, phone: created.phone }}
          onClose={() => router.push(`/admin/buyers/${created.id}`)}
        />
      )}
    </div>
  );
}

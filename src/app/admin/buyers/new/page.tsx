"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { addBuyer, uploadBuyerCard } from "@/app/admin/buyers/actions";
import { CredentialModal } from "@/components/admin/CredentialModal";
import { palette } from "@/lib/palette";

const EMPTY = {
  business_name: "", owner_name: "", email: "", phone: "+91", city: "", gstin: "",
  address: "", transport_details: "", broker_details: "", other_details: "", notes: "",
};

// Case B — manual add. Most fields are optional; the credential modal opens
// immediately so Rakesh can activate on the spot when ready.
export default function AddBuyerPage() {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; email: string; owner_name: string; business_name: string; phone: string } | null>(null);
  const [f, setF] = useState(EMPTY);
  const [cardFile, setCardFile] = useState<File | null>(null);

  // Draft autosave — a half-filled form survives closing the app / navigating
  // away. Cleared on successful create. (The photo can't be drafted.)
  const DRAFT_KEY = "drevi:draft:add-buyer";
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) setF({ ...EMPTY, ...JSON.parse(raw) });
    } catch { /* corrupt draft — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const hasContent = Object.entries(f).some(([k, v]) => v.trim() !== "" && !(k === "phone" && v === "+91"));
    try {
      if (hasContent) localStorage.setItem(DRAFT_KEY, JSON.stringify(f));
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* storage full/blocked — non-fatal */ }
  }, [f]);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  function save() {
    setError(null);
    start(async () => {
      const res = await addBuyer(f);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      if (cardFile) {
        const fd = new FormData();
        fd.append("card", cardFile);
        await uploadBuyerCard(res.id!, fd); // best-effort; buyer exists either way
      }
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* non-fatal */ }
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
      <Link href="/admin/buyers" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}>
        <ChevronLeft size={14} /> Buyers
      </Link>
      <h1 className="font-display mt-3" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Add Buyer</h1>
      <p className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige }}>Fill what you have. Email becomes required at credential activation.</p>

      <div className="mt-5 flex flex-col gap-4">
        {field("Business name", "business_name")}
        {field("Owner name", "owner_name", true)}
        {field("Email", "email", false, "email")}
        {field("Phone", "phone", true)}
        {field("City", "city")}
        {field("GSTIN", "gstin")}
        {area("Address", "address")}
        {area("Transport details", "transport_details")}
        {area("Broker details", "broker_details")}
        {area("Other details", "other_details")}
        {area("Notes", "notes")}
        <label className="flex flex-col gap-1.5">
          <span className={labelCls} style={labelStyle}>Visiting card / photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => setCardFile(e.target.files?.[0] ?? null)}
            className="font-body"
            style={{ fontSize: 12 }}
          />
          {cardFile && <span className="font-body" style={{ fontSize: 10, color: palette.goldDeep }}>{cardFile.name} ({Math.round(cardFile.size / 1024)} KB)</span>}
        </label>
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

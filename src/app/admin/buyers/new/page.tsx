"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { addBuyer } from "@/app/admin/buyers/actions";
import { CredentialModal } from "@/components/admin/CredentialModal";
import { palette } from "@/lib/palette";

// Case B — manual add. On save the buyer is created (pending/manual_admin) and
// the credential modal opens immediately (spec §6.2 / §7.5).
export default function AddBuyerPage() {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; email: string; owner_name: string; business_name: string; phone: string } | null>(null);
  const [f, setF] = useState({ business_name: "", owner_name: "", email: "", phone: "+91", city: "", gstin: "", notes: "" });

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  function save() {
    setError(null);
    start(async () => {
      const res = await addBuyer(f);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setCreated({ id: res.id!, email: f.email.trim().toLowerCase(), owner_name: f.owner_name, business_name: f.business_name, phone: f.phone });
    });
  }

  const field = (label: string, key: keyof typeof f, required = false, type = "text") => (
    <label className="flex flex-col gap-1.5">
      <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>{label}{required ? " *" : ""}</span>
      <input type={type} value={f[key]} onChange={set(key)} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "7px 2px", fontSize: 13 }} />
    </label>
  );

  return (
    <div className="px-4 md:px-8 py-6 max-w-md">
      <Link href="/admin/buyers" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}>
        <ChevronLeft size={14} /> Buyers
      </Link>
      <h1 className="font-display mt-3" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Add Buyer</h1>

      <div className="mt-5 flex flex-col gap-4">
        {field("Business name", "business_name", true)}
        {field("Owner name", "owner_name", true)}
        {field("Email", "email", true, "email")}
        {field("Phone", "phone", true)}
        {field("City", "city", true)}
        {field("GSTIN", "gstin")}
        {field("Notes", "notes")}
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

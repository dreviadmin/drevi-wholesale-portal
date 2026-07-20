"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, MessageCircle } from "lucide-react";
import { VendorModal, type VendorRow } from "../VendorsView";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";

interface ReceiptSummary { id: string; number: string; date: string; createdBy: string; pieces: number; value: number }

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

export function VendorDetail({ vendor, receipts }: { vendor: VendorRow; receipts: ReceiptSummary[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const wa = (vendor.whatsapp || vendor.phone)?.replace(/[^\d]/g, "").replace(/^0+/, "");
  const waUrl = wa ? `https://wa.me/${wa.length === 10 ? "91" + wa : wa}` : null;
  const totalValue = receipts.reduce((s, r) => s + r.value, 0);

  return (
    <>
      <div className="mt-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display" style={{ fontSize: 24, fontWeight: 600, color: palette.black }}>
            {vendor.name}
            {!vendor.active && <span className="font-body uppercase ml-2" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige }}>Inactive</span>}
          </h1>
          <div className="font-body mt-1 flex items-center gap-2" style={{ fontSize: 12.5, color: palette.softBlack }}>
            {[vendor.phone, vendor.city].filter(Boolean).join(" · ") || "—"}
            {waUrl && <a href={waUrl} target="_blank" rel="noreferrer" aria-label="WhatsApp"><MessageCircle size={14} strokeWidth={1.7} color={palette.goldDeep} /></a>}
          </div>
          {vendor.gstin && <div className="font-body mt-0.5" style={{ fontSize: 11.5, color: palette.mutedGreige }}>GSTIN {vendor.gstin}</div>}
          {vendor.address && <div className="font-body mt-0.5" style={{ fontSize: 11.5, color: palette.mutedGreige }}>{vendor.address}</div>}
        </div>
        <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>
          <Pencil size={12} /> Edit
        </button>
      </div>

      {vendor.notes && (
        <div className="mt-4 p-3 font-body" style={{ background: palette.ivoryDeep, fontSize: 12, color: palette.softBlack }}>{vendor.notes}</div>
      )}

      <div className="mt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Goods Receipts · {receipts.length}</h2>
          {totalValue > 0 && <span className="font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>lifetime {formatINR(totalValue)}</span>}
        </div>
        {receipts.length === 0 ? (
          <p className="font-body mt-2" style={{ fontSize: 12, color: palette.mutedGreige }}>No receipts yet.</p>
        ) : (
          <div className="mt-2 flex flex-col">
            {receipts.map((r) => (
              <Link key={r.id} href={`/admin/receipts/${r.id}`} className="flex items-center gap-3 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.07)" }}>
                <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>{r.number}</span>
                <span className="font-body" style={{ fontSize: 11, color: palette.mutedGreige }}>{fmtDate(r.date)}</span>
                <span className="font-body ml-auto" style={{ fontSize: 11.5, color: palette.softBlack }}>{r.pieces} pc</span>
                <span className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{formatINR(r.value)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <VendorModal vendor={vendor} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); router.refresh(); }} />
      )}
    </>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, X, ScanLine, Plus, MessageCircle } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { createVendor, updateVendor, type VendorForm } from "./actions";
import { palette } from "@/lib/palette";

export interface VendorRow {
  id: string;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  city: string | null;
  gstin: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  receipts: number;
  lastReceipt: string | null;
  skus: string[]; // SKUs seen on this vendor's receipt lines (for scan lookup)
}

function waLink(phone: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d]/g, "").replace(/^0+/, "");
  if (digits.length === 10) digits = "91" + digits;
  return digits ? `https://wa.me/${digits}` : null;
}
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const ACCESSORS: Record<string, SortAccessor<VendorRow>> = {
  name: (r) => r.name,
  city: (r) => r.city,
  phone: (r) => r.phone,
  receipts: (r) => r.receipts,
  last: (r) => r.lastReceipt,
  active: (r) => (r.active ? "Active" : "Inactive"),
};

export function VendorsView({ rows, sheetVendorBySku }: { rows: VendorRow[]; sheetVendorBySku: Record<string, string> }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<VendorRow | "new" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2400); };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [r.name, r.city, r.phone, r.gstin].some((v) => v?.toLowerCase().includes(q)));
  }, [rows, query]);

  const { sorted, sort, toggle } = useSort(filtered, ACCESSORS, { key: "name", dir: "asc" });

  // Scan a garment tag → resolve its vendor: receipt lines first, then the
  // sheet's vendor name (normalised) as fallback.
  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty scan" };
    const byReceipt = rows.find((r) => r.skus.includes(sku));
    if (byReceipt) {
      setScanning(false);
      setQuery(byReceipt.name);
      return { ok: true, message: `${sku} → ${byReceipt.name} (from receipts)` };
    }
    const sheetName = sheetVendorBySku[sku];
    if (sheetName) {
      const match = rows.find((r) => norm(r.name) === norm(sheetName));
      setScanning(false);
      setQuery(match?.name ?? sheetName);
      return { ok: true, message: `${sku} → ${sheetName} (from sheet)` };
    }
    return { ok: false, message: `${sku} — no vendor on record` };
  }

  return (
    <div className="px-4 md:px-6 py-5 max-w-4xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Vendors</h1>
        <button type="button" onClick={() => setEditing("new")} className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "9px 16px" }}>
          <Plus size={13} strokeWidth={2.5} /> Add Vendor
        </button>
      </div>

      <div className="mt-4 flex items-center gap-2 max-w-md" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px" }}>
        <Search size={15} color={palette.mutedGreige} strokeWidth={1.7} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, city, phone, GSTIN" className="font-body bg-transparent outline-none w-full" style={{ fontSize: 12.5, color: palette.black }} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} color={palette.mutedGreige} /></button>}
        <button type="button" onClick={() => setScanning(true)} aria-label="Scan a tag to find its vendor" className="flex items-center gap-1.5 font-body uppercase flex-shrink-0" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}>
          <ScanLine size={13} strokeWidth={1.7} /> Scan
        </button>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 640 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              <SortTh label="Name" k="name" sort={sort} onToggle={toggle} />
              <SortTh label="City" k="city" sort={sort} onToggle={toggle} />
              <SortTh label="Phone" k="phone" sort={sort} onToggle={toggle} />
              <SortTh label="Receipts" k="receipts" sort={sort} onToggle={toggle} right defaultDir="desc" />
              <SortTh label="Last receipt" k="last" sort={sort} onToggle={toggle} defaultDir="desc" />
              <SortTh label="Status" k="active" sort={sort} onToggle={toggle} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const wa = waLink(r.whatsapp || r.phone);
              return (
                <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", opacity: r.active ? 1 : 0.55 }}>
                  <td style={{ padding: "10px" }}>
                    <Link href={`/admin/vendors/${r.id}`} className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black, borderBottom: `1px solid ${palette.gold}` }}>{r.name}</Link>
                  </td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.city ?? "—"}</td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>
                    <span className="inline-flex items-center gap-1.5">
                      {r.phone ?? "—"}
                      {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label="WhatsApp"><MessageCircle size={13} strokeWidth={1.7} color={palette.goldDeep} /></a>}
                    </span>
                  </td>
                  <td className="font-body text-right" style={{ fontSize: 12, color: palette.black, padding: "10px" }}>{r.receipts}</td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px" }}>{fmtDate(r.lastReceipt)}</td>
                  <td className="font-body" style={{ fontSize: 11.5, color: r.active ? palette.goldDeep : palette.mutedGreige, padding: "10px" }}>{r.active ? "Active" : "Inactive"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="text-center py-10 font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>No vendors{query ? " match" : " yet — add the first one"}.</div>}
      </div>

      {editing && (
        <VendorModal
          vendor={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); flash(msg); router.refresh(); }}
        />
      )}

      {scanning && <QrScanner title="Scan a tag to find its vendor" onScan={handleScan} onClose={() => setScanning(false)} />}

      {toast && <div className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase z-[60]" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px" }}>{toast}</div>}
    </div>
  );
}

export function VendorModal({ vendor, onClose, onSaved }: {
  vendor: VendorRow | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [form, setForm] = useState<VendorForm & { active?: boolean }>({
    name: vendor?.name ?? "",
    phone: vendor?.phone ?? "",
    whatsapp: vendor?.whatsapp ?? "",
    city: vendor?.city ?? "",
    address: vendor?.address ?? "",
    gstin: vendor?.gstin ?? "",
    notes: vendor?.notes ?? "",
    active: vendor?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasReceipts = (vendor?.receipts ?? 0) > 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = vendor ? await updateVendor(vendor.id, form) : await createVendor(form);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      onSaved(vendor ? "Vendor updated" : "Vendor added");
    } finally {
      setBusy(false);
    }
  }

  const FIELDS: [keyof VendorForm, string][] = [
    ["name", "Name"], ["phone", "Phone"], ["whatsapp", "WhatsApp (if different)"],
    ["city", "City"], ["address", "Address"], ["gstin", "GSTIN"], ["notes", "Notes"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !busy && onClose()}>
      <div className="w-full sm:max-w-md max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px", paddingBottom: "calc(20px + var(--kb-inset, 0px))" }} onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>{vendor ? "Edit Vendor" : "Add Vendor"}</h2>
        <div className="flex flex-col gap-3 mt-4">
          {FIELDS.map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>{label}</span>
              <input
                value={(form[key] as string) ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                className="font-body bg-transparent outline-none"
                style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13.5 }}
              />
            </label>
          ))}
          {vendor && (
            <label className="flex items-center gap-2 font-body" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
              Active
              {hasReceipts && !form.active && <span style={{ fontSize: 10, color: palette.mutedGreige }}>(has receipts — deactivated, never deleted)</span>}
            </label>
          )}
        </div>
        {error && <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.crimsonText }}>{error}</p>}
        <div className="flex gap-2 mt-5">
          <button type="button" onClick={save} disabled={busy} className="flex-1 font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 0" }}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={onClose} disabled={busy} className="font-body uppercase px-5" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

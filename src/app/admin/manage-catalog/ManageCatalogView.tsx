"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Search, X, Lock, Unlock, Eye, EyeOff, Pencil, ImageOff } from "lucide-react";
import {
  updateProductFields, unlockProductField, uploadProductPhotoAction, renameProductSku, setProductVisibility,
} from "./actions";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

const FIELDS: { key: string; label: string; type?: "number" | "textarea" | "bool" }[] = [
  { key: "title", label: "Title" },
  { key: "wholesale_price", label: "Wholesale price ₹", type: "number" },
  { key: "category", label: "Category" },
  { key: "sub_category", label: "Sub-category" },
  { key: "color", label: "Colour" },
  { key: "primary_fabric", label: "Fabric" },
  { key: "min_order_qty", label: "MOQ", type: "number" },
  { key: "current_qty", label: "Stock qty", type: "number" },
  { key: "restockable", label: "Restockable", type: "bool" },
  { key: "restock_days", label: "Restock days", type: "number" },
  { key: "description", label: "Description", type: "textarea" },
];

export function ManageCatalogView({ products }: { products: WholesaleProduct[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<WholesaleProduct | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.sku.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q) || (p.category ?? "").toLowerCase().includes(q));
  }, [products, query]);

  return (
    <div className="px-4 md:px-6 py-5 max-w-5xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Manage Catalog</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, color: palette.mutedGreige }}>
        Edit any product. A field you change is <b>locked</b> — the sheet sync won’t overwrite it until you unlock it.
      </p>

      <div className="mt-4 flex items-center gap-2 max-w-md sticky top-0 z-10" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "8px 10px", background: palette.pageBg }}>
        <Search size={15} color={palette.mutedGreige} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU, title, category" className="font-body bg-transparent outline-none w-full" style={{ fontSize: 13, color: palette.black }} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear"><X size={14} color={palette.mutedGreige} /></button>}
      </div>

      <div className="mt-3 font-body" style={{ fontSize: 11, color: palette.mutedGreige }}>{filtered.length} of {products.length}</div>

      <div className="mt-2 flex flex-col">
        {filtered.map((p) => {
          const locked = p.locked_fields ?? [];
          return (
            <button
              key={p.sku}
              type="button"
              onClick={() => setEditing(p)}
              className="flex items-center gap-3 py-2.5 text-left"
              style={{ borderBottom: "1px solid rgba(26,26,26,0.07)", opacity: p.wholesale_visible ? 1 : 0.5 }}
            >
              <div className="relative flex-shrink-0 flex items-center justify-center" style={{ width: 40, height: 50, background: palette.ivoryDeep }}>
                {p.image_urls?.[0] ? <Image src={p.image_urls[0]} alt="" fill sizes="40px" className="object-cover" /> : <ImageOff size={16} color={palette.mutedGreige} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-display truncate" style={{ fontSize: 13, fontWeight: 500, color: palette.black }}>{p.title ?? p.sku}</div>
                <div className="font-body" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.06em" }}>
                  {p.sku}{!p.wholesale_visible ? " · HIDDEN" : ""}{locked.length ? ` · ${locked.length} locked` : ""}
                </div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="font-display" style={{ fontSize: 13, fontWeight: 600, color: p.wholesale_price > 0 ? palette.black : palette.mutedGreige }}>
                  {p.wholesale_price > 0 ? formatINR(p.wholesale_price) : "—"}
                </div>
              </div>
              <Pencil size={14} color={palette.mutedGreige} className="flex-shrink-0" />
            </button>
          );
        })}
      </div>

      {editing && (
        <EditModal
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

function EditModal({ product, onClose, onSaved }: { product: WholesaleProduct; onClose: () => void; onSaved: () => void }) {
  const router = useRouter();
  const [locked, setLocked] = useState<Set<string>>(() => new Set(product.locked_fields ?? []));
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of FIELDS) {
      const raw = (product as unknown as Record<string, unknown>)[f.key];
      v[f.key] = f.type === "bool" ? (raw ? "true" : "false") : raw == null ? "" : String(raw);
    }
    return v;
  });
  const [newSku, setNewSku] = useState(product.sku);
  const [photoUrl, setPhotoUrl] = useState(product.image_urls?.[0] ?? null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2500); }

  // Only send fields whose value actually changed.
  function saveFields() {
    const edits: Record<string, string> = {};
    for (const f of FIELDS) {
      const raw = (product as unknown as Record<string, unknown>)[f.key];
      const orig = f.type === "bool" ? (raw ? "true" : "false") : raw == null ? "" : String(raw);
      if (values[f.key] !== orig) edits[f.key] = values[f.key];
    }
    if (Object.keys(edits).length === 0) { flash("No changes"); return; }
    setError(null);
    start(async () => {
      const res = await updateProductFields(product.sku, edits);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      onSaved();
    });
  }

  // Per-field unlock keeps the modal open (only reflects the badge + refreshes
  // the list behind it) — closing on each unlock was jarring.
  function unlock(field: string) {
    start(async () => {
      const res = await unlockProductField(product.sku, field);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setLocked((s) => { const n = new Set(s); n.delete(field); return n; });
      flash(`${field} unlocked — sheet controls it again`);
      router.refresh();
    });
  }

  function onPhoto(file: File | null) {
    if (!file) return;
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.append("image", file);
      const res = await uploadProductPhotoAction(product.sku, fd);
      if (!res.ok) { setError(res.error ?? "Upload failed"); return; }
      setPhotoUrl(res.url ?? null);
      setLocked((s) => new Set(s).add("image_urls")); // flip the badge to LOCKED
      flash("Photo updated");
      router.refresh();
    });
  }

  function doRename() {
    if (newSku.trim().toUpperCase() === product.sku.toUpperCase()) return;
    if (!window.confirm(`Rename SKU ${product.sku} → ${newSku.trim().toUpperCase()}? The old SKU will be ignored by the sheet sync.`)) return;
    setError(null);
    start(async () => {
      const res = await renameProductSku(product.sku, newSku);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      onSaved();
    });
  }

  function toggleVisible() {
    start(async () => {
      const res = await setProductVisibility(product.sku, !product.wholesale_visible);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      onSaved();
    });
  }

  const lockBadge = (field: string) =>
    locked.has(field) ? (
      <button type="button" onClick={() => unlock(field)} className="flex items-center gap-1 font-body" style={{ fontSize: 8.5, color: palette.goldDeep, letterSpacing: "0.08em" }}>
        <Lock size={10} /> LOCKED · unlock
      </button>
    ) : (
      <span className="flex items-center gap-1 font-body" style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.08em" }}><Unlock size={10} /> from sheet</span>
    );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !isPending && onClose()}>
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-display truncate pr-3" style={{ fontSize: 16, fontWeight: 600, color: palette.black }}>{product.title ?? product.sku}</h2>
          <button type="button" onClick={() => !isPending && onClose()} aria-label="Close"><X size={18} color={palette.softBlack} /></button>
        </div>

        {/* Photo */}
        <div className="flex gap-3 mt-4">
          <div className="relative flex-shrink-0 flex items-center justify-center" style={{ width: 90, height: 113, background: palette.ivoryDeep }}>
            {photoUrl ? <Image src={photoUrl} alt="" fill sizes="90px" className="object-cover" /> : <ImageOff size={20} color={palette.mutedGreige} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige }}>Photo</span>
              {lockBadge("image_urls")}
            </div>
            <label className="mt-2 inline-block font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, padding: "7px 12px", cursor: "pointer" }}>
              Replace photo
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0] ?? null)} />
            </label>
            <button type="button" onClick={toggleVisible} disabled={isPending} className="mt-2 flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: product.wholesale_visible ? palette.crimsonText : palette.goldDeep }}>
              {product.wholesale_visible ? <><EyeOff size={12} /> Hide from catalog</> : <><Eye size={12} /> Show in catalog</>}
            </button>
          </div>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-3 mt-4">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="flex items-center justify-between">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.softBlack }}>{f.label}</span>
                {lockBadge(f.key)}
              </span>
              {f.type === "textarea" ? (
                <textarea value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} rows={2} className="font-body bg-transparent outline-none resize-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12.5 }} />
              ) : f.type === "bool" ? (
                <select value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="font-body" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12.5, background: palette.ivory }}>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <input value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} inputMode={f.type === "number" ? "decimal" : undefined} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13.5 }} />
              )}
            </label>
          ))}
        </div>

        {/* SKU rename */}
        <div className="mt-4 p-3" style={{ background: palette.ivoryDeep }}>
          <div className="flex items-center gap-2">
            <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige }}>SKU</span>
            {lockBadge("sku")}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <input value={newSku} onChange={(e) => setNewSku(e.target.value.toUpperCase())} className="font-body bg-transparent outline-none flex-1" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12.5, letterSpacing: "0.04em" }} />
            <button type="button" onClick={doRename} disabled={isPending || newSku.trim().toUpperCase() === product.sku.toUpperCase()} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, padding: "8px 12px" }}>Rename</button>
          </div>
        </div>

        {error && <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.crimsonText }}>{error}</p>}
        {toast && <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.goldDeep }}>{toast}</p>}

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={saveFields} disabled={isPending} className="flex-1 font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 0" }}>{isPending ? "Saving…" : "Save Changes"}</button>
          <button type="button" onClick={() => !isPending && onClose()} className="font-body uppercase px-5" style={{ border: `1px solid ${palette.black}`, fontSize: 10, letterSpacing: "0.16em" }}>Close</button>
        </div>
      </div>
    </div>
  );
}

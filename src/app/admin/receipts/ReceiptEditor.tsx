"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X, ScanLine, Minus, Plus, ImageOff } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { ZoomImage } from "@/components/Lightbox";
import { uuid } from "@/lib/uuid";
import { createReceipt, updateReceipt, uploadReceiptBill, type ReceiptInput } from "./actions";
import { quickAddVendor } from "@/app/admin/vendors/actions";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";

export interface VendorOption { id: string; name: string; city: string | null }
export interface EditorLine { key: string; sku: string; description: string; qty: number; unitCost: string }
export interface ReceiptEditorInitial {
  id?: string; // set = edit mode
  vendorId?: string;
  receiptDate?: string;
  billAmount?: string;
  notes?: string;
  billPhotoUrl?: string | null;
  lines?: EditorLine[];
}

const DRAFT_KEY = "drevi_receipt_draft_v1";
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
// "1,500" or "₹1500" must not silently become 0.
const num = (v: string) => Number(String(v ?? "").replace(/[^\d.]/g, "")) || 0;

export function ReceiptEditor({ vendors, registrySkus, initial, prefillSku }: {
  vendors: VendorOption[];
  registrySkus: string[];
  initial?: ReceiptEditorInitial;
  prefillSku?: string;
}) {
  const router = useRouter();
  const editMode = !!initial?.id;
  const known = useMemo(() => new Set(registrySkus.map((s) => s.toUpperCase())), [registrySkus]);

  const [vendorId, setVendorId] = useState(initial?.vendorId ?? "");
  const [vendorQuery, setVendorQuery] = useState("");
  const [showVendorAdd, setShowVendorAdd] = useState(false);
  const [newVendor, setNewVendor] = useState({ name: "", phone: "" });
  const [vendorList, setVendorList] = useState(vendors);
  const [receiptDate, setReceiptDate] = useState(initial?.receiptDate ?? istToday());
  const [billAmount, setBillAmount] = useState(initial?.billAmount ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [billFile, setBillFile] = useState<File | null>(null);
  const [billPreview, setBillPreview] = useState<string | null>(initial?.billPhotoUrl ?? null);
  const [lines, setLines] = useState<EditorLine[]>(initial?.lines ?? []);
  const [skuQuery, setSkuQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRefRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // Draft restore (new mode only) — a ?sku= deep link ADDS its line to any
  // saved draft rather than clobbering it (the operator may have a half-built
  // receipt going when a duplicate-variant pops up).
  useEffect(() => {
    if (editMode || restoredRef.current) return;
    restoredRef.current = true;
    let restored: EditorLine[] = [];
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.lines?.length || d.vendorId) {
          setVendorId(d.vendorId ?? "");
          setReceiptDate(d.receiptDate ?? istToday());
          setBillAmount(d.billAmount ?? "");
          setNotes(d.notes ?? "");
          restored = d.lines ?? [];
        }
      }
    } catch { /* corrupted draft */ }
    if (prefillSku) {
      const key = prefillSku.toUpperCase();
      if (!restored.some((l) => l.sku === key)) {
        restored = [...restored, { key: uuid(), sku: key, description: "", qty: 1, unitCost: "" }];
      }
    }
    if (restored.length > 0) setLines(restored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, prefillSku]);
  useEffect(() => {
    if (editMode) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ vendorId, receiptDate, billAmount, notes, lines }));
    } catch { /* full */ }
  }, [editMode, vendorId, receiptDate, billAmount, notes, lines]);

  const addLine = useCallback((sku: string) => {
    const key = sku.trim().toUpperCase();
    if (!key) return { qty: 0, known: true };
    // Read through the ref — the scanner's camera loop captures the first
    // render's callback (same pattern as the billing wizard).
    const existing = linesRef.current.find((l) => l.sku === key);
    setLines((ls) => {
      const ex = ls.find((l) => l.sku === key);
      if (ex) return ls.map((l) => (l.sku === key ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { key: uuid(), sku: key, description: "", qty: 1, unitCost: "" }];
    });
    return { qty: existing ? existing.qty + 1 : 1, known: known.size === 0 || known.has(key) };
  }, [known]);

  // Continuous scanning straight into lines — a repeat scan increments qty.
  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty scan" };
    const r = addLine(sku);
    const tail = r.known === false ? " · not in registry" : "";
    return { ok: true, message: `${sku} · qty ${r.qty}${tail}` };
  }

  const vendorMatches = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendorList.slice(0, 6);
    return vendorList.filter((v) => v.name.toLowerCase().includes(q) || (v.city ?? "").toLowerCase().includes(q)).slice(0, 6);
  }, [vendorList, vendorQuery]);
  const selectedVendor = vendorList.find((v) => v.id === vendorId) ?? null;

  async function doQuickAddVendor() {
    if (!newVendor.name.trim()) return;
    const res = await quickAddVendor(newVendor.name, newVendor.phone);
    if (!res.ok) { setError(res.error ?? "Vendor add failed"); return; }
    setVendorList((v) => [...v, { id: res.id!, name: newVendor.name.trim(), city: null }]);
    setVendorId(res.id!);
    setShowVendorAdd(false);
    setNewVendor({ name: "", phone: "" });
  }

  const totals = useMemo(() => {
    const pieces = lines.reduce((n, l) => n + l.qty, 0);
    const value = lines.reduce((n, l) => n + l.qty * num(l.unitCost), 0);
    return { pieces, value };
  }, [lines]);
  const billNum = num(billAmount);
  const mismatch = billNum > 0 && Math.abs(billNum - totals.value) > 0.5;

  async function save() {
    setError(null);
    if (!vendorId) { setError("Pick a vendor."); return; }
    if (lines.length === 0) { setError("Add at least one line."); return; }
    const input: ReceiptInput = {
      vendorId,
      receiptDate,
      billAmount: billAmount.trim() === "" ? null : num(billAmount),
      notes,
      lines: lines.map((l) => ({ sku: l.sku, description: l.description, qty: l.qty, unitCost: num(l.unitCost) })),
    };
    setBusy(true);
    try {
      if (editMode) {
        const res = await updateReceipt(initial!.id!, input);
        if (!res.ok) { setError(res.error ?? "Failed"); return; }
        if (billFile) {
          const fd = new FormData();
          fd.append("bill", billFile);
          const up = await uploadReceiptBill(initial!.id!, fd);
          if (!up.ok) window.alert(`Saved, but the bill photo failed to upload: ${up.error ?? "unknown error"}. Add it again from the receipt page.`);
        }
        router.push(`/admin/receipts/${initial!.id}`);
        router.refresh();
      } else {
        input.clientRef = clientRefRef.current ?? (clientRefRef.current = uuid());
        const res = await createReceipt(input);
        if (!res.ok) { setError(res.error ?? "Failed"); return; }
        if (billFile && res.id) {
          const fd = new FormData();
          fd.append("bill", billFile);
          const up = await uploadReceiptBill(res.id, fd);
          if (!up.ok) window.alert(`Receipt saved, but the bill photo failed to upload: ${up.error ?? "unknown error"}. Add it again from the receipt page.`);
        }
        try { localStorage.removeItem(DRAFT_KEY); } catch { /* non-fatal */ }
        router.push(`/admin/receipts/${res.id}`);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const label = (t: string) => (
    <span className="font-body uppercase block" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige, marginBottom: 4 }}>{t}</span>
  );

  return (
    <div className="mt-4">
      {/* 1. Vendor */}
      <div className="p-3" style={{ background: palette.ivoryDeep }}>
        {label("Vendor")}
        {selectedVendor ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display" style={{ fontSize: 15, fontWeight: 600, color: palette.black }}>{selectedVendor.name}</span>
            {selectedVendor.city && <span className="font-body" style={{ fontSize: 11, color: palette.mutedGreige }}>{selectedVendor.city}</span>}
            <button type="button" onClick={() => { setVendorId(""); setVendorQuery(""); }} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.1em", color: palette.goldDeep }}>Change</button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 10px", background: palette.ivory }}>
              <Search size={14} color={palette.mutedGreige} />
              <input value={vendorQuery} onChange={(e) => setVendorQuery(e.target.value)} placeholder="Search vendors" className="font-body flex-1 bg-transparent outline-none" style={{ fontSize: 12.5 }} />
            </div>
            <div style={{ border: "1px solid rgba(26,26,26,0.1)", borderTop: "none", background: palette.ivory }}>
              {vendorMatches.map((v) => (
                <button key={v.id} type="button" onClick={() => setVendorId(v.id)} className="w-full text-left px-3 py-2 font-body" style={{ fontSize: 12.5, borderBottom: "1px solid rgba(26,26,26,0.05)" }}>
                  {v.name}{v.city ? ` · ${v.city}` : ""}
                </button>
              ))}
              {vendorMatches.length === 0 && <div className="font-body px-3 py-2" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No vendors match.</div>}
            </div>
            {!showVendorAdd ? (
              <button type="button" onClick={() => setShowVendorAdd(true)} className="mt-2 flex items-center gap-1.5 font-body" style={{ fontSize: 10.5, color: palette.goldDeep }}>
                <Plus size={12} /> New vendor
              </button>
            ) : (
              <div className="mt-2 flex items-end gap-2 flex-wrap">
                <input value={newVendor.name} onChange={(e) => setNewVendor((f) => ({ ...f, name: e.target.value }))} placeholder="Vendor name" className="font-body bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12.5, background: palette.ivory }} />
                <input value={newVendor.phone} onChange={(e) => setNewVendor((f) => ({ ...f, phone: e.target.value }))} placeholder="Phone (optional)" className="font-body bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12.5, background: palette.ivory }} />
                <button type="button" onClick={doQuickAddVendor} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", background: palette.black, color: palette.ivory, padding: "8px 12px" }}>Add</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 2. Date + bill photo + amount */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <div>
          {label("Receipt date")}
          <input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} className="font-body w-full" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 12.5, background: palette.ivory }} />
        </div>
        <div>
          {label("Bill amount ₹ (as printed)")}
          <input inputMode="decimal" value={billAmount} onChange={(e) => setBillAmount(e.target.value)} placeholder="optional" className="font-body w-full bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 12.5, background: palette.ivory }} />
        </div>
        <div>
          {label("Bill photo")}
          <div className="flex items-center gap-2">
            {billPreview ? (
              <ZoomImage src={billPreview} alt="Vendor bill" width={44} height={56} />
            ) : (
              <div className="flex items-center justify-center flex-shrink-0" style={{ width: 44, height: 56, background: palette.ivoryDeep }}>
                <ImageOff size={14} color={palette.mutedGreige} />
              </div>
            )}
            <label className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, padding: "8px 11px", cursor: "pointer" }}>
              {billPreview ? "Replace" : "Add photo"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setBillFile(f);
                  if (f) setBillPreview(URL.createObjectURL(f));
                }}
              />
            </label>
          </div>
        </div>
      </div>

      {/* 3. Lines */}
      <div className="mt-4">
        {label(`Lines · ${lines.length}`)}
        <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 10px" }}>
          <Search size={14} color={palette.mutedGreige} />
          <input
            value={skuQuery}
            onChange={(e) => setSkuQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && skuQuery.trim()) { addLine(skuQuery); setSkuQuery(""); } }}
            placeholder="Type a SKU and press Enter"
            className="font-body flex-1 bg-transparent outline-none"
            style={{ fontSize: 12.5 }}
          />
          <button type="button" onClick={() => { if (skuQuery.trim()) { addLine(skuQuery); setSkuQuery(""); } }} className="font-body uppercase flex-shrink-0" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", border: `1px solid ${palette.black}` }}>Add</button>
          <button type="button" onClick={() => setScanning(true)} className="flex items-center gap-1.5 font-body uppercase flex-shrink-0" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}>
            <ScanLine size={13} strokeWidth={1.7} /> Scan
          </button>
        </div>

        {lines.length === 0 ? (
          <p className="font-body mt-2" style={{ fontSize: 11.5, color: palette.mutedGreige }}>Scan tags straight into lines — a repeat scan bumps the quantity.</p>
        ) : (
          <div className="mt-2 flex flex-col">
            {lines.map((l) => {
              const unknown = known.size > 0 && !known.has(l.sku);
              return (
                <div key={l.key} className="py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.07)" }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>{l.sku}</span>
                    {unknown && <span className="font-body" style={{ fontSize: 8.5, color: palette.crimsonText }}>not in registry</span>}
                    <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove ${l.sku}`} className="ml-auto p-1"><X size={14} color={palette.mutedGreige} /></button>
                  </div>
                  {unknown && (
                    <input
                      value={l.description}
                      onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, description: e.target.value } : x)))}
                      placeholder="What is this piece? (free text)"
                      className="font-body w-full bg-transparent outline-none mt-1"
                      style={{ borderBottom: "1px dashed rgba(26,26,26,0.25)", padding: "3px 2px", fontSize: 11.5 }}
                    />
                  )}
                  <div className="flex items-center gap-4 mt-1.5 flex-wrap">
                    <div className="flex items-center" style={{ border: "1px solid rgba(26,26,26,0.2)" }}>
                      <button type="button" onClick={() => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} className="px-2.5 py-1.5" aria-label="Fewer"><Minus size={12} /></button>
                      <span className="font-body" style={{ minWidth: 30, textAlign: "center", fontSize: 13, fontWeight: 600 }}>{l.qty}</span>
                      <button type="button" onClick={() => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x)))} className="px-2.5 py-1.5" aria-label="More"><Plus size={12} /></button>
                    </div>
                    <label className="flex items-center gap-1.5 font-body" style={{ fontSize: 12 }}>
                      ₹/pc
                      <input inputMode="decimal" value={l.unitCost} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unitCost: e.target.value } : x)))} placeholder="0" className="font-body bg-transparent outline-none text-right" style={{ width: 84, borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "3px 4px", fontSize: 13 }} />
                    </label>
                    <span className="font-display ml-auto" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>
                      {formatINR(l.qty * num(l.unitCost))}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Totals + mismatch */}
      {lines.length > 0 && (
        <div className="mt-3 font-body" style={{ fontSize: 12.5, color: palette.softBlack }}>
          <div className="flex justify-between"><span>{totals.pieces} piece{totals.pieces === 1 ? "" : "s"}</span><b>{formatINR(totals.value)}</b></div>
          {mismatch && (
            <div className="mt-1 inline-block px-2 py-1 font-body" style={{ background: palette.amberSoft, fontSize: 10.5, color: palette.goldDeep }}>
              Bill shows {formatINR(billNum)} — itemised total differs by {formatINR(Math.abs(billNum - totals.value))}. Vendor bills legitimately differ; saving anyway is fine.
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        {label("Notes")}
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className="font-body w-full bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 12.5 }} />
      </div>

      {error && <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.crimsonText }}>{error}</p>}

      <button type="button" onClick={save} disabled={busy} className="mt-4 w-full font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "14px 0" }}>
        {busy ? "Saving…" : editMode ? "Save Changes" : "Save Receipt"}
      </button>

      {scanning && <QrScanner title="Scan pieces into the receipt" onScan={handleScan} onClose={() => setScanning(false)} holdFeedback />}
    </div>
  );
}

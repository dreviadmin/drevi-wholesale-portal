"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, X, ScanLine, Plus, Minus, Camera, Image as ImageIcon, Trash2, ChevronDown, Check, Package, AlertTriangle } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { KeyboardInset } from "@/components/KeyboardInset";
import { HsnInput } from "@/components/admin/HsnInput";
import { ColorCombobox } from "@/components/admin/ColorCombobox";
import { DraftNotice } from "@/components/DraftNotice";
import { useDraft, isDraftOlderThan, DRAFT_NOTICE_AFTER_MS, type DraftMeta } from "@/lib/useDraft";
import { DEFAULT_HSN } from "@/lib/hsn-default";
import { palette } from "@/lib/palette";
import { uuid } from "@/lib/uuid";
import { formatINR } from "@/lib/format";
import type { LiveVocab } from "@/lib/sku/vocab-live";
import { queueTray } from "@/app/admin/sku-generator/labels";
import { resolveGarmentDesign, uploadIdentPhoto, saveDelivery, quickAddVendor, type SupplyBlock, type SavedDesign } from "./delivery-actions";

// Retrofit R3 (§5) — "Log delivery". One screen: vendor block that collapses,
// a list of garment cards (one per DESIGN, not per size), and a full-screen
// capture sheet. Assume connectivity (§5.8): drafts autosave against refresh,
// but there is no offline queue and no locally invented SKU.

const DRAFT_KEY = "drevi:delivery:draft";
const SHEET_DRAFT_KEY = "drevi:delivery:sheet";

interface Vendor { id: string; name: string; city: string | null }
interface KnownDesign { id: string; baseSku: string; color: string; title: string | null; identRef: string | null; supply: SupplyBlock; supplyUpdatedAt: string | null; vendorSku: string | null; lastCost: number | null }

interface Garment {
  key: string;
  designId?: string;
  baseSku?: string;
  color?: string;
  cat?: string;
  sub?: string;
  newColor?: string;
  title?: string;
  description: string;
  vendorSku: string;
  unitCost: string;
  hsn: string;
  sizes: { size: string; qty: number }[];
  supply: SupplyBlock;
  identRef?: string | null;
  identImageId?: string;
  variantSkus: string[];
  isReorder: boolean;
  supplyStale?: boolean;
}

const emptyGarment = (): Garment => ({
  key: uuid(), description: "", vendorSku: "", unitCost: "", hsn: DEFAULT_HSN, sizes: [], supply: {}, variantSkus: [], isReorder: false,
});

type Gst = { mode: "kaccha" | "pakka" | null; rate: number | null; inclusive: boolean | null };
interface DeliveryDraft { vendorId: string; receiptDate: string; billAmount: string; gst: Gst; notes: string; garments: Garment[]; clientRef: string }

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
// clientRef lives in the draft: saveDelivery is idempotent on it, so a retry
// after a refresh resolves to the same receipt. Minted fresh per empty form.
const emptyDraft = (): DeliveryDraft => ({
  vendorId: "", receiptDate: istToday(), billAmount: "", gst: { mode: null, rate: 5, inclusive: true }, notes: "", garments: [], clientRef: uuid(),
});

export function DeliveryIntake({
  vendors: initialVendors,
  knownDesigns,
  uploadsOk,
  uploadsMessage,
  staleDays,
  hsnOptions,
  vocab,
}: {
  vendors: Vendor[];
  knownDesigns: KnownDesign[];
  uploadsOk: boolean;
  uploadsMessage: string;
  staleDays: number;
  hsnOptions: string[];
  vocab: LiveVocab;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [vendors, setVendors] = useState(initialVendors);
  // §5.8 — draft autosave protects refresh / back-swipe / restart. Pre-hook
  // drafts on shop devices are this same shape, so they restore as-is.
  const [draft, setDraft, draftMeta] = useDraft<DeliveryDraft>(DRAFT_KEY, emptyDraft, {
    hasContent: (d) => !!d.vendorId || d.garments.length > 0,
    onRestore: (d) => ({ ...emptyDraft(), ...d }),
  });
  const { vendorId, receiptDate, billAmount, gst, notes, garments } = draft;
  const setVendorId = (v: string) => setDraft((d) => ({ ...d, vendorId: v }));
  const setReceiptDate = (v: string) => setDraft((d) => ({ ...d, receiptDate: v }));
  const setBillAmount = (v: string) => setDraft((d) => ({ ...d, billAmount: v }));
  const setNotes = (v: string) => setDraft((d) => ({ ...d, notes: v }));
  const setGst = (u: SetStateAction<Gst>) => setDraft((d) => ({ ...d, gst: typeof u === "function" ? u(d.gst) : u }));
  const setGarments = (u: SetStateAction<Garment[]>) => setDraft((d) => ({ ...d, garments: typeof u === "function" ? u(d.garments) : u }));
  const [vendorQuery, setVendorQuery] = useState("");
  const [newVendor, setNewVendor] = useState<{ name: string; phone: string } | null>(null);
  const [headerOpen, setHeaderOpen] = useState(true);
  // The open capture sheet is its own draft so a half-captured garment survives
  // a refresh: a restored sheet reopens itself; Cancel / Add to delivery clear it.
  const [sheet, setSheet, sheetMeta] = useDraft<Garment | null>(SHEET_DRAFT_KEY, null, { hasContent: (g) => !!g });
  const [toast, setToast] = useState<string | null>(null);
  // Save-only success step (§6.1): the form is replaced by a panel that points
  // at the master editor / specs for each design on the receipt.
  const [saved, setSaved] = useState<{ receiptId: string; receiptNumber: string; skus: string[]; designs: SavedDesign[]; pieces: number; value: number } | null>(null);
  const entryDate = useMemo(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }), []);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2600); }

  // Restored garments mean the vendor block is already filled — collapse it.
  useEffect(() => {
    if (draftMeta.restored && draft.garments.length > 0) setHeaderOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftMeta.restored]);

  const vendor = vendors.find((v) => v.id === vendorId);
  const totals = useMemo(() => {
    let pieces = 0, value = 0, tags = 0;
    for (const g of garments) {
      const q = g.sizes.reduce((s, x) => s + x.qty, 0);
      pieces += q;
      value += q * (Number(g.unitCost) || 0);
      tags += g.variantSkus.length;
    }
    return { designs: garments.length, pieces, value, tags };
  }, [garments]);
  const billNum = Number(billAmount) || 0;
  const mismatch = billNum > 0 && Math.abs(billNum - totals.value) > 1;

  function upsertGarment(g: Garment) {
    setGarments((list) => {
      const i = list.findIndex((x) => x.key === g.key);
      if (i === -1) return [...list, g];
      const next = [...list]; next[i] = g; return next;
    });
  }

  async function onSave(thenPrint: boolean) {
    if (!vendorId) { flash("Pick a vendor first"); return; }
    if (garments.length === 0) { flash("Add at least one garment"); return; }
    startTransition(async () => {
      const res = await saveDelivery({
        vendorId,
        receiptDate,
        billAmount: billNum || null,
        gst: { mode: gst.mode, rate: gst.rate, inclusive: gst.inclusive },
        notes,
        clientRef: draft.clientRef,
        garments: garments.map((g) => ({
          designId: g.designId,
          baseSku: g.baseSku,
          description: g.description,
          vendorSku: g.vendorSku,
          unitCost: Number(g.unitCost) || 0,
          hsn: g.hsn?.trim() || undefined,
          sizes: g.sizes,
          supply: g.supply,
          identImageId: g.identImageId,
        })),
      });
      if (!res) { flash("Session expired — sign in again; the delivery is kept as a draft"); return; }
      if (!res.ok) { flash(res.error ?? "Save failed"); return; }
      // §5.6 — Save & print tags stages EXACTLY this delivery's SKUs; Save only
      // queues them behind whatever the device already has in the tray.
      queueTray(res.skus ?? [], thenPrint ? "replace" : "merge");
      // The success panel keeps garments in state for the ident thumbs; the
      // draft state does not change there, so nothing is re-written until
      // resetForNext() replaces it.
      draftMeta.clear();
      flash(`${res.receiptNumber} saved`);
      if (thenPrint) {
        router.push(`/admin/sku-generator?tab=print&receipt=${encodeURIComponent(res.receiptNumber ?? "")}`);
        return;
      }
      // Fallback keeps the panel useful if the action returns no designs
      // (e.g. an older idempotent replay).
      const designs: SavedDesign[] = res.designs ?? garments
        .filter((g) => g.designId)
        .map((g) => ({ id: g.designId!, baseSku: g.baseSku ?? "", color: g.color ?? "", title: g.description || g.title || null, created: !g.isReorder, specsVerified: false }));
      setSaved({ receiptId: res.receiptId!, receiptNumber: res.receiptNumber!, skus: res.skus ?? [], designs, pieces: totals.pieces, value: totals.value });
      window.scrollTo({ top: 0 });
    });
  }

  function resetForNext() {
    setSaved(null);
    // emptyDraft() mints a fresh clientRef — saveDelivery is idempotent on it,
    // so reusing it would silently return the receipt just saved.
    setDraft(emptyDraft());
    setVendorQuery("");
    setNewVendor(null);
    setHeaderOpen(true);
  }

  const label = (t: string) => (
    <span className="font-body uppercase block" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige, marginBottom: 3 }}>{t}</span>
  );
  const input = { fontSize: 13, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "9px 11px", width: "100%" } as const;

  const toastEl = toast && (
    <div className="fixed bottom-36 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2 flex items-center gap-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
      <Check size={13} color={palette.gold} /> {toast}
    </div>
  );

  if (saved) {
    const actionBtn = { fontSize: 9, letterSpacing: "0.14em", padding: "7px 11px" } as const;
    return (
      <div className="pb-10">
        <div className="p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
          <div className="flex items-center gap-2">
            <Check size={16} color="#1F6B45" />
            <span className="font-mono" style={{ fontSize: 18, fontWeight: 700, color: palette.black }}>{saved.receiptNumber}</span>
          </div>
          <div className="font-body mt-1" style={{ fontSize: 11.5, color: palette.softBlack }}>
            {saved.designs.length} design{saved.designs.length === 1 ? "" : "s"} · {saved.pieces} pc · {formatINR(saved.value)} · {saved.skus.length} tag{saved.skus.length === 1 ? "" : "s"} queued
          </div>
        </div>

        <div className="mt-4">
          {label("Complete product details")}
          <div className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige, lineHeight: 1.5 }}>
            New designs land at Awaiting specs — add fabric, handwork, origin, price, then Confirmed by Rakesh.
          </div>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {saved.designs.map((d) => {
            const identRef = garments.find((g) => g.designId === d.id)?.identRef;
            return (
              <div key={d.id} className="p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
                <div className="flex items-center gap-3">
                  {identRef ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/drive-photo?id=${encodeURIComponent(identRef)}&s=200`} alt="" style={{ width: 46, height: 58, objectFit: "cover", background: palette.ivoryDeep }} />
                  ) : (
                    <span className="flex items-center justify-center flex-shrink-0" style={{ width: 46, height: 58, background: palette.ivoryDeep }}><Camera size={14} color={palette.mutedGreige} /></span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="font-mono block truncate" style={{ fontSize: 11.5, fontWeight: 700, color: palette.black }}>{d.baseSku}·{d.color}</span>
                    <span className="font-body block truncate" style={{ fontSize: 11, color: palette.softBlack }}>{d.title || "—"}</span>
                    <span className="font-body uppercase inline-block mt-1" style={{ fontSize: 8, letterSpacing: "0.12em", padding: "3px 6px", background: d.created ? palette.amberSoft : palette.ivoryDeep, color: d.created ? palette.goldDeep : palette.softBlack }}>
                      {d.created ? "New · awaiting specs" : "Reorder"}
                    </span>
                  </span>
                </div>
                <div className="flex gap-2 mt-2.5">
                  <Link href={`/admin/studio/master/${d.id}`} className="font-body uppercase" style={{ ...actionBtn, background: palette.black, color: palette.ivory }}>Product details</Link>
                  <Link href={`/admin/specs/${d.id}`} className="font-body uppercase" style={{ ...actionBtn, border: `1px solid ${palette.black}`, color: palette.black }}>Specs</Link>
                </div>
              </div>
            );
          })}
          {saved.designs.length === 0 && (
            <div className="font-body text-center py-4" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No designs on this receipt.</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <Link href={`/admin/sku-generator?tab=print&receipt=${encodeURIComponent(saved.receiptNumber)}`} className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.16em", background: palette.gold, color: palette.black, fontWeight: 600, padding: "11px 16px" }}>
            Print tags ({saved.skus.length})
          </Link>
          <Link href={`/admin/receipts/${saved.receiptId}`} className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "11px 14px" }}>
            View receipt
          </Link>
          <button type="button" onClick={resetForNext} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", color: palette.mutedGreige, padding: "11px 6px" }}>
            Log another delivery
          </button>
        </div>

        {toastEl}
      </div>
    );
  }

  // Discarding the restored delivery must also reopen the vendor block the
  // restore collapsed, or the empty form would sit behind a "—" chip.
  const headerDraftMeta: DraftMeta = { ...draftMeta, discard: () => { draftMeta.discard(); setHeaderOpen(true); } };

  return (
    <div className="pb-40">
      {isDraftOlderThan(draftMeta, DRAFT_NOTICE_AFTER_MS) && <div className="mb-3"><DraftNotice meta={headerDraftMeta} /></div>}

      {/* 1 — Vendor & dates, collapses to a chip once set (§5.2) */}
      {headerOpen ? (
        <div className="p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
          <div className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Vendor &amp; dates</div>
          <div className="mt-2">
            {label("Vendor")}
            <div className="flex items-center gap-2">
              <Search size={14} color={palette.mutedGreige} />
              <input value={vendorQuery} onChange={(e) => setVendorQuery(e.target.value)} placeholder="Search vendors" className="font-body" style={input} />
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {vendors
                .filter((v) => !vendorQuery.trim() || v.name.toLowerCase().includes(vendorQuery.trim().toLowerCase()))
                .slice(0, 8)
                .map((v) => (
                  <button key={v.id} type="button" onClick={() => setVendorId(v.id)} className="font-body" style={{ fontSize: 11, padding: "7px 11px", border: `1px solid ${vendorId === v.id ? palette.black : "rgba(26,26,26,0.15)"}`, background: vendorId === v.id ? palette.black : "transparent", color: vendorId === v.id ? palette.ivory : palette.softBlack }}>
                    {v.name}{v.city ? ` · ${v.city}` : ""}
                  </button>
                ))}
              <button type="button" onClick={() => setNewVendor({ name: vendorQuery, phone: "" })} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "7px 10px", border: `1px dashed ${palette.goldDeep}`, color: palette.goldDeep }}>
                + New vendor
              </button>
            </div>
            {newVendor && (
              <div className="mt-2 p-2.5 flex flex-col gap-2" style={{ background: "#fff", border: `1px solid ${palette.goldDeep}` }}>
                <input autoFocus value={newVendor.name} onChange={(e) => setNewVendor({ ...newVendor, name: e.target.value })} placeholder="Vendor name" className="font-body" style={input} />
                <input value={newVendor.phone} onChange={(e) => setNewVendor({ ...newVendor, phone: e.target.value })} placeholder="Phone (optional)" className="font-body" style={input} />
                <div className="flex gap-2">
                  <button type="button" disabled={pending || !newVendor.name.trim()} onClick={() => startTransition(async () => {
                    const r = await quickAddVendor(newVendor.name, newVendor.phone);
                    if (!r) { flash("Session expired — sign in again"); return; }
                    if (!r.ok) { flash(r.error ?? "Failed"); return; }
                    setVendors((vs) => [...vs, { id: r.id!, name: r.name!, city: null }].sort((a, b) => a.name.localeCompare(b.name)));
                    setVendorId(r.id!); setNewVendor(null); flash(`${r.name} added`);
                  })} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "9px 12px" }}>Save vendor</button>
                  <button type="button" onClick={() => setNewVendor(null)} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", color: palette.mutedGreige, padding: "9px 6px" }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div>{label("Receipt date (vendor's bill)")}<input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} className="font-body" style={input} /></div>
            <div>{label("Entry date")}<div className="font-body" style={{ ...input, background: palette.ivoryDeep, color: palette.mutedGreige }}>{entryDate}</div></div>
            <div>{label("Bill amount (optional)")}<input type="number" min="0" value={billAmount} onChange={(e) => setBillAmount(e.target.value)} className="font-body" style={input} /></div>
            <div className="col-span-2 flex flex-wrap items-center gap-1.5">
              {(["kaccha", "pakka"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setGst((g) => ({ ...g, mode: g.mode === m ? null : m }))} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", padding: "6px 10px", background: gst.mode === m ? palette.black : "transparent", color: gst.mode === m ? palette.ivory : palette.black, border: gst.mode === m ? "none" : "1px solid rgba(26,26,26,0.2)" }}>
                  {m === "kaccha" ? "Kaccha" : "Pakka (GST)"}
                </button>
              ))}
              {gst.mode === "pakka" && (
                <>
                  {[5, 18].map((r) => (
                    <button key={r} type="button" onClick={() => setGst((g) => ({ ...g, rate: r }))} className="font-body" style={{ fontSize: 9.5, padding: "6px 9px", background: gst.rate === r ? palette.goldDeep : "transparent", color: gst.rate === r ? palette.ivory : palette.black, border: gst.rate === r ? "none" : "1px solid rgba(26,26,26,0.2)" }}>
                      {r}%
                    </button>
                  ))}
                  <select value={gst.inclusive === false ? "excl" : "incl"} onChange={(e) => setGst((g) => ({ ...g, inclusive: e.target.value === "incl" }))} className="font-body" style={{ fontSize: 10, border: "1px solid rgba(26,26,26,0.2)", padding: "6px 7px", background: "transparent", color: palette.black }}>
                    <option value="incl">Incl. GST</option>
                    <option value="excl">GST on top</option>
                  </select>
                </>
              )}
            </div>
            <div>{label("Notes")}<input value={notes} onChange={(e) => setNotes(e.target.value)} className="font-body" style={input} /></div>
          </div>
          {vendorId && (
            <button type="button" onClick={() => setHeaderOpen(false)} className="mt-3 font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "9px 14px" }}>Done</button>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setHeaderOpen(true)} className="w-full flex items-center gap-2 p-3 text-left" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
          <Package size={14} color={palette.goldDeep} />
          <span className="font-body flex-1" style={{ fontSize: 12.5, color: palette.black }}>
            {vendor?.name ?? "—"} · {receiptDate}{billNum > 0 ? ` · ${formatINR(billNum)}` : ""}
          </span>
          <ChevronDown size={14} color={palette.mutedGreige} />
        </button>
      )}

      {/* 2 — Garment cards */}
      <div className="mt-3 flex flex-col gap-1.5">
        {garments.map((g) => {
          const pieces = g.sizes.reduce((s, x) => s + x.qty, 0);
          return (
            <div key={g.key} className="flex items-center gap-3 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
              <button type="button" onClick={() => setSheet(g)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                {g.identRef ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/drive-photo?id=${encodeURIComponent(g.identRef)}&s=200`} alt="" style={{ width: 46, height: 58, objectFit: "cover", background: palette.ivoryDeep }} />
                ) : (
                  <span className="flex items-center justify-center" style={{ width: 46, height: 58, background: palette.ivoryDeep }}><Camera size={14} color={palette.mutedGreige} /></span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="font-mono block truncate" style={{ fontSize: 11.5, fontWeight: 700, color: palette.black }}>{g.baseSku ? `${g.baseSku}·${g.color}` : "new garment"}</span>
                  <span className="font-body block truncate" style={{ fontSize: 11, color: palette.softBlack }}>{g.description || g.title || "—"}</span>
                  <span className="font-mono block mt-0.5" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
                    {g.sizes.map((s) => `${s.size}×${s.qty}`).join(" · ") || "no sizes"} · {formatINR(Number(g.unitCost) || 0)}
                    {g.supply.supplyMode ? ` · ${g.supply.supplyMode.replace("_", " ")}` : ""}
                    {g.variantSkus.length ? ` · ${g.variantSkus.length} tag${g.variantSkus.length === 1 ? "" : "s"}` : ""}
                  </span>
                </span>
                <span className="font-display flex-shrink-0" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{pieces} pc</span>
              </button>
              <button type="button" onClick={() => setGarments((l) => l.filter((x) => x.key !== g.key))} aria-label="Remove garment" className="p-1"><Trash2 size={14} color={palette.mutedGreige} /></button>
            </div>
          );
        })}
        {garments.length === 0 && (
          <div className="font-body text-center py-6" style={{ fontSize: 12, color: palette.mutedGreige }}>No garments yet — add the first one below.</div>
        )}
      </div>

      {/* 3 — primary action */}
      <button type="button" onClick={() => setSheet(emptyGarment())} className="mt-3 w-full flex items-center justify-center gap-2 font-body uppercase" style={{ fontSize: 11.5, letterSpacing: "0.18em", background: palette.gold, color: palette.black, fontWeight: 600, padding: "16px 0" }}>
        <Plus size={16} /> Add garment
      </button>

      {!uploadsOk && (
        <div className="mt-3 flex items-start gap-2 p-3" style={{ background: "#FBF3E4", border: "1px solid #C9A227" }}>
          <AlertTriangle size={14} color="#8a6d1a" />
          <span className="font-body" style={{ fontSize: 11, color: "#8a6d1a", lineHeight: 1.5 }}>
            {uploadsMessage} Everything else on this screen works — photos can be added from Studio once the folder is configured.
          </span>
        </div>
      )}

      {/* 4 — footer totals + save (§5.2/5.6) */}
      <div className="fixed bottom-16 md:bottom-0 inset-x-0 z-30 px-3 pb-2 pointer-events-none">
        <div className="mx-auto max-w-2xl pointer-events-auto p-3" style={{ background: palette.black, boxShadow: "0 -4px 20px rgba(0,0,0,0.25)" }}>
          <div className="flex items-center justify-between">
            <span className="font-body" style={{ fontSize: 11, color: palette.champagne }}>
              {totals.designs} design{totals.designs === 1 ? "" : "s"} · {totals.pieces} pc · {formatINR(totals.value)}
              {totals.tags > 0 ? ` · ${totals.tags} tags` : ""}
            </span>
            {mismatch && <span className="font-body" style={{ fontSize: 9.5, color: "#E4A1A1" }}>bill {formatINR(billNum)}</span>}
          </div>
          <div className="flex gap-2 mt-2">
            <button type="button" disabled={pending} onClick={() => onSave(true)} className="flex-1 font-body uppercase disabled:opacity-50" style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.gold, color: palette.black, fontWeight: 600, padding: "13px 0" }}>
              Save &amp; print tags
            </button>
            <button type="button" disabled={pending} onClick={() => onSave(false)} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 10, letterSpacing: "0.14em", border: `1px solid ${palette.champagne}`, color: palette.ivory, padding: "13px 14px" }}>
              Save only
            </button>
          </div>
        </div>
      </div>

      {sheet && (
        <GarmentSheet
          garment={sheet}
          onChange={(u) => setSheet((s) => (s == null ? s : typeof u === "function" ? u(s) : u))}
          draftMeta={sheetMeta}
          knownDesigns={knownDesigns}
          uploadsOk={uploadsOk}
          uploadsMessage={uploadsMessage}
          staleDays={staleDays}
          hsnOptions={hsnOptions}
          vocab={vocab}
          onCancel={sheetMeta.discard}
          onDone={(g) => { upsertGarment(g); sheetMeta.discard(); setHeaderOpen(false); }}
          flash={flash}
        />
      )}

      {toastEl}
    </div>
  );
}

// ---------------------------------------------------------------------------
// §5.3 — the garment capture sheet: identify · sizes → mint · photo · quantities+cost · supply
// (the ident photo is filed under the minted SKU, so mint comes first)
// ---------------------------------------------------------------------------
function GarmentSheet({
  garment, onChange, draftMeta, knownDesigns, uploadsOk, uploadsMessage, staleDays, hsnOptions, vocab, onCancel, onDone, flash,
}: {
  garment: Garment;
  onChange: Dispatch<SetStateAction<Garment>>;
  draftMeta: DraftMeta;
  knownDesigns: KnownDesign[];
  uploadsOk: boolean;
  uploadsMessage: string;
  staleDays: number;
  hsnOptions: string[];
  vocab: LiveVocab;
  onCancel: () => void;
  onDone: (g: Garment) => void;
  flash: (m: string) => void;
}) {
  // Controlled by the parent's sheet draft (§5.8) so every edit is persisted.
  const g = garment, setG = onChange;
  const [pending, startTransition] = useTransition();
  const [scanOpen, setScanOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mintOpen, setMintOpen] = useState(!garment.designId && !garment.baseSku);
  const [supplyOpen, setSupplyOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  useEffect(() => {
    if (g.isReorder && g.supplyStale) setSupplyOpen(true); // §5.5 re-prompt only when stale
  }, [g.isReorder, g.supplyStale]);

  const input = { fontSize: 13, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "9px 11px", width: "100%" } as const;
  const label = (t: string) => (
    <span className="font-body uppercase block" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige, marginBottom: 3 }}>{t}</span>
  );
  const photoTile = { background: palette.ivory, border: "1px dashed rgba(26,26,26,0.25)", minHeight: 92, padding: "14px 8px" } as const;
  // uploadIdentPhoto files the photo under base_sku+colour — no design, no photo.
  const photoDisabled = pending || !g.designId;

  function pickKnown(d: KnownDesign) {
    const stale = !d.supplyUpdatedAt || Date.now() - new Date(d.supplyUpdatedAt).getTime() > staleMs;
    setG((s) => ({
      ...s,
      designId: d.id, baseSku: d.baseSku, color: d.color, title: d.title ?? "",
      description: s.description || d.title || "",
      vendorSku: s.vendorSku || d.vendorSku || "",
      unitCost: s.unitCost || (d.lastCost ? String(d.lastCost) : ""),
      identRef: d.identRef, supply: { ...d.supply, ...s.supply }, isReorder: true, supplyStale: stale,
    }));
    setMintOpen(false);
    setQuery("");
  }

  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    const parts = sku.split("-");
    if (parts.length >= 5 && /^\d{2,4}$/.test(parts[3])) {
      const base = parts.slice(0, 4).join("-"), color = parts[parts.length - 1];
      const match = knownDesigns.find((d) => d.baseSku === base && d.color === color);
      if (match) { pickKnown(match); setScanOpen(false); return { ok: true, message: `${base}·${color}` }; }
    }
    setScanOpen(false);
    return { ok: false, message: "Not a known design — use New design" };
  }

  // Sizes drive minting (§5.4): resolving happens when sizes are set.
  function resolveDesign() {
    const sizes = g.sizes.map((s) => s.size);
    if (sizes.length === 0) { flash("Pick at least one size first"); return; }
    startTransition(async () => {
      const res = await resolveGarmentDesign({
        designId: g.designId,
        cat: g.cat, sub: g.sub, color: g.newColor,
        description: g.description,
        sizes,
      });
      // An expired session makes the action resolve to undefined (auth redirect).
      if (!res) { flash("Session expired — sign in again; your garment is kept as a draft"); return; }
      if (!res.ok) { flash(res.error ?? "Could not mint"); return; }
      setG((s) => ({ ...s, designId: res.designId, baseSku: res.baseSku, color: res.color, variantSkus: res.variantSkus ?? [] }));
      flash(res.created ? `Minted ${res.baseSku}` : `${res.variantSkus?.length} SKU(s) ready`);
    });
  }

  function onPhoto(file: File) {
    if (!g.designId) { flash("Mint the SKU first — the photo is filed under it"); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("photo", file);
      const res = await uploadIdentPhoto(g.designId!, fd);
      if (!res) { flash("Session expired — sign in again; your garment is kept as a draft"); return; }
      if (!res.ok) { flash(res.error ?? "Upload failed"); return; }
      setG((s) => ({ ...s, identImageId: res.imageId, identRef: res.fileRef ?? null }));
      flash("Ident photo saved");
    });
  }

  const matches = query.trim()
    ? knownDesigns.filter((d) => `${d.baseSku} ${d.color} ${d.title ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];
  const subs = g.cat ? Object.entries((vocab.categories as Record<string, { subs: Record<string, string> }>)[g.cat]?.subs ?? {}) : [];
  const sizeOrder = Object.keys(vocab.sizes);
  // Sizes show once the design is identified (scan/search) or fully described (new).
  const identifyReady = !!g.baseSku || (mintOpen && !!g.cat && !!g.sub && !!g.newColor);
  const unminted = g.baseSku && g.color
    ? g.sizes.filter((s) => !g.variantSkus.some((v) => v.toUpperCase() === `${g.baseSku}-${s.size}-${g.color}`.toUpperCase()))
    : [];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" style={{ background: palette.pageBg }}>
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3" style={{ background: palette.black }}>
        <span className="font-body uppercase" style={{ fontSize: 10.5, letterSpacing: "0.2em", color: palette.ivory }}>Capture garment</span>
        <button type="button" onClick={onCancel} aria-label="Close"><X size={18} color={palette.champagne} /></button>
      </div>

      <div className="px-4 py-4 max-w-xl mx-auto pb-40">
        {draftMeta.restored && <div className="mb-3"><DraftNotice meta={draftMeta} label="Garment capture restored" /></div>}

        {/* a. Identify */}
        <div className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Identify</div>
        <div className="flex gap-2 mt-2">
          <button type="button" onClick={() => setScanOpen(true)} className="flex-1 flex items-center justify-center gap-1.5 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.12em", background: palette.black, color: palette.ivory, padding: "12px 0" }}>
            <ScanLine size={14} /> Scan tag
          </button>
          <button type="button" onClick={() => { setMintOpen(true); setG((s) => ({ ...s, designId: undefined, baseSku: undefined, isReorder: false, identRef: null, variantSkus: [] })); }} className="flex-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, padding: "12px 0" }}>
            New design
          </button>
        </div>
        <div className="mt-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search existing designs" className="font-body" style={input} />
          {matches.length > 0 && (
            <div className="mt-1 flex flex-col" style={{ border: "1px solid rgba(26,26,26,0.12)", background: "#fff" }}>
              {matches.map((d) => (
                <button key={d.id} type="button" onClick={() => pickKnown(d)} className="flex items-center gap-2 p-2 text-left" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                  <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, color: palette.black }}>{d.baseSku}·{d.color}</span>
                  <span className="font-body truncate" style={{ fontSize: 11, color: palette.mutedGreige }}>{d.title ?? ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {mintOpen && !g.baseSku && (
          <div className="mt-2 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)" }}>
            {label("Category")}
            <div className="flex flex-wrap gap-1">
              {Object.entries(vocab.categories).map(([code, c]) => (
                <button key={code} type="button" onClick={() => setG((s) => ({ ...s, cat: code, sub: undefined }))} className="font-body" style={{ fontSize: 10, padding: "6px 9px", border: `1px solid ${g.cat === code ? palette.black : "rgba(26,26,26,0.15)"}`, background: g.cat === code ? palette.black : "transparent", color: g.cat === code ? palette.ivory : palette.softBlack }}>
                  {(c as { name: string }).name}
                </button>
              ))}
            </div>
            {g.cat && (
              <>
                <div className="mt-2">{label("Sub-category")}</div>
                <div className="flex flex-wrap gap-1">
                  {subs.map(([code, name]) => (
                    <button key={code} type="button" onClick={() => setG((s) => ({ ...s, sub: code }))} className="font-body" style={{ fontSize: 10, padding: "6px 9px", border: `1px solid ${g.sub === code ? palette.black : "rgba(26,26,26,0.15)"}`, background: g.sub === code ? palette.black : "transparent", color: g.sub === code ? palette.ivory : palette.softBlack }}>
                      {name as string}
                    </button>
                  ))}
                </div>
              </>
            )}
            {g.sub && (
              <div className="mt-2">
                {label("Colour")}
                <ColorCombobox value={g.newColor ?? ""} onChange={(code) => setG((s) => ({ ...s, newColor: code || undefined }))} groups={vocab.colorGroups} style={input} autoFocus />
              </div>
            )}
          </div>
        )}

        {/* Sizes received → mint (§5.4: the first size mints the base SKU).
            Quantities are counted later, after the photo. */}
        {identifyReady && (
          <div className="mt-2 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)" }}>
            {label("Sizes received")}
            <div className="flex flex-wrap gap-1.5">
              {sizeOrder.map((size) => {
                const row = g.sizes.find((s) => s.size === size);
                return (
                  <div key={size} className="flex items-center" style={{ border: `1px solid ${row ? palette.black : "rgba(26,26,26,0.15)"}`, background: row ? palette.black : "transparent" }}>
                    <button type="button" onClick={() => setG((s) => ({ ...s, sizes: row ? s.sizes.filter((x) => x.size !== size) : [...s.sizes, { size, qty: 1 }] }))} className="font-body" style={{ fontSize: 10.5, padding: "7px 9px", color: row ? palette.ivory : palette.softBlack, fontWeight: row ? 600 : 400 }}>
                      {size}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="mt-2">{label("Name / description")}<input value={g.description} onChange={(e) => setG((s) => ({ ...s, description: e.target.value }))} className="font-body" style={input} /></div>
            {g.sizes.length === 0 && (
              <div className="font-body mt-2" style={{ fontSize: 9.5, color: palette.mutedGreige }}>{g.baseSku ? "Pick the sizes received to prepare the tags." : "Pick the sizes received to mint the SKU."}</div>
            )}
            {!g.baseSku && g.sizes.length > 0 && (
              <button type="button" disabled={pending || !g.cat || !g.sub || !g.newColor} onClick={resolveDesign} className="mt-3 w-full font-body uppercase disabled:opacity-40" style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.black, color: palette.ivory, padding: "13px 0" }}>
                Mint SKU{g.sizes.length > 1 ? `s (${g.sizes.length})` : ""}
              </button>
            )}
            {/* resolveDesign passes designId, so the server mints only the
                variants not yet in the registry — safe to re-run. */}
            {g.baseSku && g.designId && unminted.length > 0 && (
              <button type="button" disabled={pending} onClick={resolveDesign} className="mt-3 w-full font-body uppercase disabled:opacity-40" style={{ fontSize: 10.5, letterSpacing: "0.16em", border: `1px solid ${palette.black}`, color: palette.black, padding: "13px 0" }}>
                {g.isReorder && g.variantSkus.length === 0 ? `Prepare ${g.sizes.length} tag${g.sizes.length === 1 ? "" : "s"}` : `Mint ${unminted.length} more SKU${unminted.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        )}

        {g.baseSku && (
          <div className="mt-2 p-2.5" style={{ background: "#DFF0E4", border: "1px solid #1F6B45" }}>
            <div className="flex items-center gap-2">
              <Check size={14} color="#1F6B45" />
              <span className="font-mono" style={{ fontSize: 12, fontWeight: 700, color: "#14532D" }}>{g.baseSku}·{g.color}</span>
              <span className="font-body" style={{ fontSize: 10, color: "#1F6B45" }}>{g.isReorder ? "existing design" : "minted"}{g.variantSkus.length ? ` · ${g.variantSkus.length} variant SKU(s)` : ""}</span>
            </div>
            {/* UX sprint — finish the record while in flow. New tabs so the
                delivery draft stays open; it also autosaves regardless. */}
            {g.designId && (
              <div className="flex gap-3 mt-1.5">
                <a href={`/admin/studio/master/${g.designId}`} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: "#1F6B45", textDecoration: "underline" }}>Product details</a>
                <a href={`/admin/specs/${g.designId}`} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: "#1F6B45", textDecoration: "underline" }}>Specs</a>
                <a href={`/admin/studio/${g.designId}`} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: "#1F6B45", textDecoration: "underline" }}>Studio</a>
              </div>
            )}
          </div>
        )}

        {/* b. Photo — tiles stay disabled until the design is minted */}
        <div className="font-body uppercase mt-5" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Photo</div>
        {!uploadsOk ? (
          <div className="mt-2 p-3 font-body" style={{ background: "#FBF3E4", border: "1px solid #C9A227", fontSize: 11, color: "#8a6d1a" }}>{uploadsMessage}</div>
        ) : (
          <>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ""; }} />
            <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ""; }} />
            {g.identRef && (
              <div className="mt-2 flex items-center gap-3 p-2.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/drive-photo?id=${encodeURIComponent(g.identRef)}&s=400`} alt="ident" style={{ width: 72, height: 90, objectFit: "cover", background: palette.ivoryDeep }} />
                <div className="min-w-0">
                  <div className="font-mono" style={{ fontSize: 11, fontWeight: 700, color: palette.black }}>{g.baseSku}·{g.color}</div>
                  <div className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>Ident photo saved — retake or replace below</div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button type="button" disabled={photoDisabled} onClick={() => fileRef.current?.click()} className="flex flex-col items-center justify-center gap-1.5 disabled:opacity-40" style={photoTile}>
                <Camera size={20} color={palette.goldDeep} />
                <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", color: palette.black }}>{g.identRef ? "Retake" : "Open camera"}</span>
              </button>
              <button type="button" disabled={photoDisabled} onClick={() => galleryRef.current?.click()} className="flex flex-col items-center justify-center gap-1.5 disabled:opacity-40" style={photoTile}>
                <ImageIcon size={20} color={palette.goldDeep} />
                <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", color: palette.black }}>{g.identRef ? "Replace from gallery" : "Choose from gallery"}</span>
              </button>
            </div>
            <div className="font-body mt-1.5" style={{ fontSize: 9.5, color: g.designId ? palette.mutedGreige : "#8a6d1a" }}>
              {g.designId ? 'Photograph the garment hanging. Optional — skipping flags "No ident photo".' : "Mint the SKU first — the photo is filed under it."}
            </div>
          </>
        )}

        {/* c. Quantities & cost — steppers only for the sizes picked above */}
        <div className="font-body uppercase mt-5" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Quantities &amp; cost</div>
        {g.sizes.length === 0 ? (
          <div className="font-body mt-2" style={{ fontSize: 10.5, color: palette.mutedGreige }}>Pick the sizes received above first.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {sizeOrder.filter((sz) => g.sizes.some((s) => s.size === sz)).map((size) => {
              const row = g.sizes.find((s) => s.size === size)!;
              return (
                <div key={size} className="flex items-center" style={{ border: `1px solid ${palette.black}`, background: palette.black }}>
                  <span className="font-body" style={{ fontSize: 10.5, padding: "7px 9px", color: palette.ivory, fontWeight: 600 }}>{size}</span>
                  <span className="flex items-center gap-1 pr-1.5">
                    <button type="button" onClick={() => setG((s) => ({ ...s, sizes: s.sizes.map((x) => x.size === size ? { ...x, qty: Math.max(1, x.qty - 1) } : x) }))} aria-label="less"><Minus size={12} color={palette.champagne} /></button>
                    <span className="font-mono" style={{ fontSize: 11, color: palette.ivory, minWidth: 14, textAlign: "center" }}>{row.qty}</span>
                    <button type="button" onClick={() => setG((s) => ({ ...s, sizes: s.sizes.map((x) => x.size === size ? { ...x, qty: x.qty + 1 } : x) }))} aria-label="more"><Plus size={12} color={palette.champagne} /></button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <div>{label("Unit cost")}<input type="number" min="0" value={g.unitCost} onChange={(e) => setG((s) => ({ ...s, unitCost: e.target.value }))} className="font-body" style={input} /></div>
          <div>{label("HSN (optional)")}<HsnInput value={g.hsn} onChange={(v) => setG((s) => ({ ...s, hsn: v }))} options={hsnOptions} style={{ ...input, borderBottom: undefined }} /></div>
          <div>{label("Vendor SKU")}<input value={g.vendorSku} onChange={(e) => setG((s) => ({ ...s, vendorSku: e.target.value }))} className="font-body" style={input} /></div>
        </div>

        {/* d. Supplier availability */}
        <button type="button" onClick={() => setSupplyOpen((v) => !v)} className="flex items-center gap-1.5 font-body uppercase mt-5" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>
          <ChevronDown size={12} style={{ transform: supplyOpen ? "rotate(180deg)" : "none" }} /> Supplier availability
          {g.supplyStale && <span className="font-body" style={{ fontSize: 9, color: "#8a6d1a", letterSpacing: 0 }}>· needs refresh</span>}
        </button>
        {supplyOpen && (
          <div className="mt-2 p-3 flex flex-col gap-2.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)" }}>
            <div>
              {label("Do they keep this in stock, make it to order, or both?")}
              <div className="flex flex-wrap gap-1">
                {(["ready_stock", "made_to_order", "both", "discontinued"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setG((s) => ({ ...s, supply: { ...s.supply, supplyMode: s.supply.supplyMode === m ? "" : m } }))} className="font-body" style={{ fontSize: 10, padding: "6px 9px", border: `1px solid ${g.supply.supplyMode === m ? palette.black : "rgba(26,26,26,0.15)"}`, background: g.supply.supplyMode === m ? palette.black : "transparent", color: g.supply.supplyMode === m ? palette.ivory : palette.softBlack }}>
                    {m.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>{label("Roughly how many ready?")}<input type="number" min="0" value={g.supply.vendorStockQty ?? ""} onChange={(e) => setG((s) => ({ ...s, supply: { ...s.supply, vendorStockQty: e.target.value === "" ? null : Number(e.target.value) } }))} className="font-body" style={input} /></div>
              <div>{label("Days to make it?")}<input type="number" min="0" value={g.supply.makingDays ?? ""} onChange={(e) => setG((s) => ({ ...s, supply: { ...s.supply, makingDays: e.target.value === "" ? null : Number(e.target.value) } }))} className="font-body" style={input} /></div>
              <div>{label("Minimum pieces per run?")}<input type="number" min="1" value={g.supply.makingMoq ?? ""} onChange={(e) => setG((s) => ({ ...s, supply: { ...s.supply, makingMoq: e.target.value === "" ? null : Number(e.target.value) } }))} className="font-body" style={input} /></div>
              <div>{label("Days to reach us?")}<input type="number" min="0" value={g.supply.deliveryDays ?? ""} onChange={(e) => setG((s) => ({ ...s, supply: { ...s.supply, deliveryDays: e.target.value === "" ? null : Number(e.target.value) } }))} className="font-body" style={input} /></div>
            </div>
            <div>{label("Anything else")}<input value={g.supply.supplyNote ?? ""} onChange={(e) => setG((s) => ({ ...s, supply: { ...s.supply, supplyNote: e.target.value } }))} placeholder="e.g. teal only, red discontinued" className="font-body" style={input} /></div>
            <div className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>Minimum run is internal — buyers never see it.</div>
          </div>
        )}
      </div>

      {/* footer */}
      <div className="fixed bottom-0 inset-x-0 px-3 pb-3" style={{ background: `linear-gradient(to top, ${palette.pageBg} 70%, transparent)` }}>
        <button
          type="button"
          disabled={pending || !g.baseSku || g.sizes.length === 0 || !g.unitCost}
          onClick={() => onDone(g)}
          className="mx-auto max-w-xl w-full block font-body uppercase disabled:opacity-40"
          style={{ fontSize: 11.5, letterSpacing: "0.18em", background: palette.gold, color: palette.black, fontWeight: 600, padding: "15px 0" }}
        >
          Add to delivery
        </button>
      </div>

      {scanOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={() => setScanOpen(false)}>
          <div className="w-full md:w-[420px] p-4" style={{ background: palette.ivory }} onClick={(e) => e.stopPropagation()}>
            <QrScanner onScan={handleScan} onClose={() => setScanOpen(false)} />
          </div>
        </div>
      )}
      <KeyboardInset />
    </div>
  );
}

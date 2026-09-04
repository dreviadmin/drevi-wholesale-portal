"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Check } from "lucide-react";
import { palette } from "@/lib/palette";
import { supplyAge } from "@/lib/availability";
import type { BoardRow } from "@/lib/studio/load";
import { saveSpecs, savePricing, saveVariant, setStockForSku, saveDesignHsn, togglePortal } from "./actions";
import { HsnInput } from "@/components/admin/HsnInput";

// Master editor client (§12.1). Group-level fields save once per design;
// size-level rows save per variant. Sheet-owned live prices keep flowing
// until the ANSH-07 cutover — the "sheet says" hints keep the parallel week
// honest without blocking editor adoption.

interface DesignFields {
  fabric: string; handwork: string; origin: string; specsVerified: boolean;
  tier: string; markupMultiplier: number; autoMrp: number | null; mrpOverride: number | null;
  vendorSku?: string | null;
  supply?: { supplyMode?: string; vendorStockQty?: number | null; makingDays?: number | null; makingMoq?: number | null; deliveryDays?: number | null; supplyNote?: string };
  supplyUpdatedAt?: string | null;
}
interface VariantRow { sku: string; current_qty: number; wholesale_price: number; wholesale_visible: boolean; hsn?: string | null; location?: string | null }

export function MasterEditor({ board, design, variants, lastCost, sheetMrp, hsn, hsnOptions }: {
  board: BoardRow;
  design: DesignFields;
  variants: VariantRow[];
  lastCost: number;
  sheetMrp: number;
  hsn: string;
  hsnOptions: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stockNote, setStockNote] = useState<Record<string, string>>({});
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetQty, setResetQty] = useState("");
  const [resetNote, setResetNote] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [specs, setSpecs] = useState({ fabric: design.fabric, handwork: design.handwork, origin: design.origin, specsVerified: design.specsVerified });
  const [pricing, setPricing] = useState({ markupMultiplier: design.markupMultiplier, mrpOverride: design.mrpOverride?.toString() ?? "" });
  const [hsnValue, setHsnValue] = useState(hsn);
  const [rows, setRows] = useState(variants.map((v) => ({ ...v, qty: String(v.current_qty), ws: String(v.wholesale_price), savedQty: Number(v.current_qty) || 0, loc: v.location ?? "" })));

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }
  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    startTransition(async () => {
      const r = await fn();
      flash(r.ok ? done : r.error ?? "Failed");
      if (r.ok) router.refresh();
    });
  }

  const previewAuto = lastCost > 0 ? Math.max(99, Math.round((lastCost * (Number(pricing.markupMultiplier) || 2.5)) / 100) * 100 - 1) : null;
  const effectiveMrp = pricing.mrpOverride ? Number(pricing.mrpOverride) : previewAuto ?? design.autoMrp;

  const section = (title: string) => (
    <div className="font-body uppercase mt-6" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>{title}</div>
  );
  const inputStyle = { fontSize: 12.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" } as const;

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl pb-16">
      <Link href={`/admin/studio/${board.id}`} className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}>
        <ChevronLeft size={14} /> Workbench
      </Link>
      <h1 className="font-mono mt-3" style={{ fontSize: 19, fontWeight: 700, color: palette.black }}>{board.baseSku} · {board.color}</h1>
      <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>{board.title ?? "—"} · Product Master</div>

      {/* Specs */}
      {section("Specs")}
      <div className="mt-2 p-3.5 flex flex-col gap-2" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        {(["fabric", "handwork", "origin"] as const).map((f) => (
          <label key={f} className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>{f}</span>
            <input value={specs[f]} onChange={(e) => setSpecs((s) => ({ ...s, [f]: e.target.value }))} className="w-full mt-1 font-body" style={inputStyle} />
          </label>
        ))}
        <label className="flex items-center gap-2 mt-1 font-body" style={{ fontSize: 12.5, color: palette.black }}>
          <input type="checkbox" checked={specs.specsVerified} onChange={(e) => setSpecs((s) => ({ ...s, specsVerified: e.target.checked }))} style={{ accentColor: palette.goldDeep }} />
          Confirmed by Rakesh
        </label>
        <button type="button" disabled={pending} onClick={() => run(() => saveSpecs(board.id, specs), "Specs saved")} className="self-start font-body uppercase disabled:opacity-40" style={{ fontSize: 9, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 12px" }}>
          Save specs
        </button>
      </div>

      {/* Pricing */}
      {section("Pricing")}
      <div className="mt-2 p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <div className="grid grid-cols-2 gap-3">
          <div className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Last cost (receipts/sheet)</span>
            <div className="font-display mt-1" style={{ fontSize: 16, fontWeight: 600, color: palette.black }}>{lastCost > 0 ? `₹${lastCost.toLocaleString("en-IN")}` : "—"}</div>
          </div>
          <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Tier multiplier ({design.tier})</span>
            <input type="number" step="0.1" min="1" max="10" value={pricing.markupMultiplier} onChange={(e) => setPricing((s) => ({ ...s, markupMultiplier: Number(e.target.value) }))} className="w-full mt-1 font-body" style={inputStyle} />
          </label>
          <div className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Auto-MRP (₹…99)</span>
            <div className="font-display mt-1" style={{ fontSize: 16, fontWeight: 600, color: palette.goldDeep }}>{previewAuto ? `₹${previewAuto.toLocaleString("en-IN")}` : "needs a cost"}</div>
          </div>
          <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>MRP override</span>
            <input type="number" min="0" value={pricing.mrpOverride} placeholder="—" onChange={(e) => setPricing((s) => ({ ...s, mrpOverride: e.target.value }))} className="w-full mt-1 font-body" style={inputStyle} />
          </label>
        </div>
        <div className="font-body mt-2" style={{ fontSize: 11, color: palette.softBlack }}>
          Effective MRP: <b style={{ color: palette.black }}>{effectiveMrp ? `₹${Number(effectiveMrp).toLocaleString("en-IN")}` : "—"}</b>
          {sheetMrp > 0 && <span style={{ color: palette.mutedGreige }}> · sheet says ₹{sheetMrp.toLocaleString("en-IN")} (live until cutover)</span>}
        </div>
        <button type="button" disabled={pending} onClick={() => run(() => savePricing(board.id, { markupMultiplier: Number(pricing.markupMultiplier), mrpOverride: pricing.mrpOverride ? Number(pricing.mrpOverride) : null }), "Pricing saved")} className="mt-2 font-body uppercase disabled:opacity-40" style={{ fontSize: 9, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 12px" }}>
          Save pricing
        </button>

        {/* Ansh (31 Jul): one HSN across every size of the design. */}
        <div className="flex items-end gap-2 mt-3 flex-wrap">
          <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>HSN (all sizes)</span>
            <div><HsnInput value={hsnValue} onChange={setHsnValue} options={hsnOptions} style={{ width: 110 }} /></div>
          </label>
          <button type="button" disabled={pending || hsnValue === hsn} onClick={() => run(() => saveDesignHsn(board.id, board.baseSku, board.color, hsnValue), "HSN saved on all sizes")} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "8px 12px" }}>
            Save HSN
          </button>
        </div>
      </div>

      {/* Supplier availability — read-only summary; edited on the cost-free
          specs view so Rakesh can work on the shared counter device (§6.2). */}
      {section("Supplier availability")}
      <div className="mt-2 p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        {design.supply?.supplyMode ? (
          <>
            <div className="font-body" style={{ fontSize: 12.5, color: palette.black }}>
              {design.supply.supplyMode.replace("_", " ")}
              {design.supply.vendorStockQty != null ? ` · ~${design.supply.vendorStockQty} ready` : ""}
              {design.supply.makingDays != null ? ` · ${design.supply.makingDays}d to make` : ""}
              {design.supply.deliveryDays != null ? ` · ${design.supply.deliveryDays}d transit` : ""}
            </div>
            {design.supply.makingMoq != null && (
              <div className="font-body mt-1" style={{ fontSize: 11, color: palette.goldDeep }}>
                Vendor makes minimum {design.supply.makingMoq} — internal only; raise the buyer MOQ if it should be passed on.
              </div>
            )}
            {design.supply.supplyNote && <div className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige }}>{design.supply.supplyNote}</div>}
          </>
        ) : (
          <div className="font-body" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No supplier data recorded.</div>
        )}
        <div className="flex items-center gap-3 mt-2">
          <Link href={`/admin/receipts?q=${encodeURIComponent(board.baseSku)}`} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}>
            Receipts
          </Link>
          <Link href={`/admin/specs/${board.id}`} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}>
            Edit specs &amp; supply
          </Link>
          <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            {supplyAge(design.supplyUpdatedAt ?? null)?.label ?? "never recorded"}
          </span>
        </div>
      </div>

      {/* Publish toggles */}
      {section("Publish")}
      <div className="mt-2 p-3.5 flex gap-4" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        {(["wholesale", "shopify"] as const).map((portal) => {
          const t = board.targets.find((x) => x.portal === portal);
          return (
            <label key={portal} className="flex items-center gap-2 font-body" style={{ fontSize: 12.5, color: palette.black }}>
              <input
                type="checkbox"
                checked={t?.enabled ?? true}
                onChange={(e) => run(() => togglePortal(board.id, portal, e.target.checked), `${portal} ${e.target.checked ? "enabled" : "disabled"}`)}
                style={{ accentColor: palette.goldDeep }}
              />
              {portal === "wholesale" ? "Wholesale" : "Shopify"}
              <span className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>({t?.state ?? "not_ready"})</span>
            </label>
          );
        })}
      </div>

      {/* Size variants */}
      {section("Sizes · stock & wholesale")}
      <div className="mt-2 flex flex-col gap-1.5">
        {rows.map((v, i) => (
          <div key={v.sku} className="flex items-center gap-2 p-2.5 flex-wrap" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
            {/* w-full on phones: the fixed-width inputs used to squeeze the
                SKU to nothing in the flex-wrap (Ansh, 4 Sep) — give it its own
                line below sm and let it share the row on wider screens. */}
            <span className="font-mono w-full sm:w-auto sm:flex-1 sm:min-w-0 truncate" style={{ fontSize: 11, fontWeight: 600, color: palette.black }}>{v.sku}</span>
            <label className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>
              qty <input type="number" min="0" value={v.qty} onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, qty: e.target.value } : r)))} className="font-body ml-1" style={{ ...inputStyle, width: 64, padding: "5px 7px" }} />
            </label>
            <label className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>
              ₹ <input type="number" min="0" value={v.ws} onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ws: e.target.value } : r)))} className="font-body ml-1" style={{ ...inputStyle, width: 84, padding: "5px 7px" }} />
            </label>
            <label className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>
              kept at <input value={v.loc} placeholder="Rack B2…" onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, loc: e.target.value } : r)))} className="font-body ml-1" style={{ ...inputStyle, width: 96, padding: "5px 7px" }} />
            </label>
            <button type="button" disabled={pending} onClick={() => run(() => saveVariant(v.sku, { currentQty: Number(v.qty) || 0, wholesalePrice: Number(v.ws) || 0, stockNote: stockNote[v.sku], location: v.loc }), `${v.sku} saved`)} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "6px 9px" }}>
              Save
            </button>
            <button type="button" onClick={() => setResetFor((cur) => (cur === v.sku ? null : v.sku))} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.1em", color: palette.mutedGreige, padding: "6px 4px" }} title="Declare a counted quantity">
              Set stock
            </button>

            {/* §10.1 — a manual stock change is a movement and needs a note. */}
            {Number(v.qty) !== v.savedQty && (
              <input
                value={stockNote[v.sku] ?? ""}
                onChange={(e) => setStockNote((s) => ({ ...s, [v.sku]: e.target.value }))}
                placeholder="Why did stock change? — required"
                className="w-full font-body p-2"
                style={{ fontSize: 11, border: "1px solid rgba(196,163,90,0.5)", background: "#FBF3E2", color: palette.black }}
              />
            )}

            {/* §10.2a — the absolute declaration. */}
            {resetFor === v.sku && (
              <div className="w-full mt-1 p-2.5" style={{ background: "#FBF3E2", border: "1px solid rgba(196,163,90,0.4)" }}>
                <div className="font-body" style={{ fontSize: 10.5, lineHeight: 1.5, color: "#8a6d1a" }}>
                  A counted quantity <b>supersedes earlier receipt arithmetic</b> for {v.sku}. Nothing is deleted —
                  earlier movements stay as history but stop counting toward stock.
                </div>
                <div className="flex flex-wrap items-end gap-2 mt-2">
                  <input value={resetQty} onChange={(e) => setResetQty(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder="counted" className="font-body text-center" style={{ width: 74, fontSize: 12.5, padding: "6px 4px", border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black }} />
                  <input value={resetNote} onChange={(e) => setResetNote(e.target.value)} placeholder="Why — required" className="flex-1 font-body p-2" style={{ minWidth: 160, fontSize: 11, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black }} />
                  <button
                    type="button"
                    disabled={pending || !resetQty.length || !resetNote.trim()}
                    onClick={() => { const sku = v.sku; run(() => setStockForSku(sku, parseInt(resetQty, 10), resetNote), `${sku} set to ${resetQty}`); setResetFor(null); setResetQty(""); setResetNote(""); }}
                    className="font-body uppercase disabled:opacity-40"
                    style={{ fontSize: 8.5, letterSpacing: "0.12em", background: palette.black, color: palette.ivory, padding: "7px 11px" }}
                  >
                    Set stock
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="font-body py-4" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No size variants on the wholesale portal yet.</div>}
      </div>

      <div className="font-body mt-4" style={{ fontSize: 10, color: palette.mutedGreige, lineHeight: 1.6 }}>
        Photos, visibility and SKU renames stay in Manage Catalog until the sheet cutover (ANSH-07). Variant saves lock their fields against the 10-minute sheet sync.
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2 flex items-center gap-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
          <Check size={13} color={palette.gold} /> {toast}
        </div>
      )}
    </div>
  );
}

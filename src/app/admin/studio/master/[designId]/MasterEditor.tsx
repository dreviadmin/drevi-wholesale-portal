"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { useDraft } from "@/lib/useDraft";
import { withFrom } from "@/components/BackLink";
import { supplyAge } from "@/lib/availability";
import { autoMrpFrom, autoWholesaleFrom, clampMultiplier, DEFAULT_MARKUP_MULTIPLIER, DEFAULT_WHOLESALE_MULTIPLIER } from "@/lib/pricing";
import { ORIGIN_OPTIONS } from "@/lib/studio/copy-prompt";
import type { BoardRow } from "@/lib/studio/load";
import type { SupplyBlock } from "@/app/admin/receipts/new/delivery-actions";
import { saveSpecs, savePricing, saveVariant, setStockForSku, saveDesignHsn, togglePortal } from "./actions";
import { HsnInput } from "@/components/admin/HsnInput";
import { BackLink } from "@/components/BackLink";
import { DraftNotice } from "@/components/DraftNotice";

// Master editor client (§12.1). Group-level fields save once per design;
// size-level rows save per variant. Sheet-owned live prices keep flowing
// until the ANSH-07 cutover — the "sheet says" hints keep the parallel week
// honest without blocking editor adoption.

interface DesignFields {
  fabric: string; handwork: string; origin: string; colorName?: string | null; specsVerified: boolean;
  tier: string; markupMultiplier: number; autoMrp: number | null; mrpOverride: number | null;
  wholesaleMultiplier: number; autoWholesale: number | null; wholesaleOverride: number | null;
  vendorSku?: string | null;
  supply?: SupplyBlock;
  supplyUpdatedAt?: string | null;
  updatedAt?: string | null;
}
interface VariantRow { sku: string; current_qty: number; wholesale_price: number; wholesale_visible: boolean; hsn?: string | null; location?: string | null }

export function MasterEditor({ board, design, variants, lastCost, lastCostLocked, sheetMrp, hsn, hsnOptions }: {
  board: BoardRow;
  design: DesignFields;
  variants: VariantRow[];
  lastCost: number;
  lastCostLocked: boolean;
  sheetMrp: number;
  hsn: string;
  hsnOptions: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetQty, setResetQty] = useState("");
  const [resetNote, setResetNote] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  // One draft per Save button so a save clears only its own key. Specs and
  // pricing live on the design row (updated_at bumps on save); HSN and the
  // size rows come from wholesale_products, so their seed is their base.
  const draftKey = `drevi:draft:master:${board.id}`;
  const specsSeed = {
    fabric: design.fabric, handwork: design.handwork, origin: design.origin,
    colorName: design.colorName ?? "", specsVerified: design.specsVerified,
    supply: design.supply ?? {},
  };
  // One wholesale price for every size, beside the MRP — both prices belong in
  // one place (Ansh, 12 Sep). The sizes only get flattened onto one number
  // when they already agree or someone types an override, so a save that only
  // touched the MRP never collapses a deliberate per-size spread.
  const wsPrices = variants.map((v) => Number(v.wholesale_price) || 0);
  const wsUniform = wsPrices.length > 0 && wsPrices.every((p) => p === wsPrices[0]);
  // The cost is prefilled, not a blank override box: it is the number itself,
  // and this cell used to just display it. Saving sends it only when it
  // DIFFERS from what was loaded, so the ordinary "Save pricing" click on a
  // design nobody re-costed writes nothing to product_vendor_info and leaves
  // the sheet in charge of that row.
  const costSeed = lastCost > 0 ? String(lastCost) : "";
  const pricingSeed = {
    markupMultiplier: design.markupMultiplier,
    mrpOverride: design.mrpOverride?.toString() ?? "",
    wholesaleMultiplier: design.wholesaleMultiplier,
    wholesaleOverride: design.wholesaleOverride?.toString() ?? "",
    lastCost: costSeed,
  };
  const specsSig = JSON.stringify(specsSeed);
  const pricingSig = JSON.stringify(pricingSeed);
  const [specs, setSpecs, specsMeta] = useDraft(`${draftKey}:specs`, specsSeed, { base: design.updatedAt ?? specsSig, hasContent: (s) => JSON.stringify(s) !== specsSig, onRestore: (d) => ({ ...specsSeed, ...d }) });
  // version 2: the wholesale half moved from a free price box onto the design
  // row (0050), so a v1 draft holds a key this form no longer submits. The
  // 20 Sep cost box needs no bump — it only ADDS a key, and onRestore spreads
  // the seed under the draft, so a v2 draft comes back with today's cost.
  const [pricing, setPricing, pricingMeta] = useDraft(`${draftKey}:pricing`, pricingSeed, { version: 2, base: design.updatedAt ?? pricingSig, hasContent: (p) => JSON.stringify(p) !== pricingSig, onRestore: (d) => ({ ...pricingSeed, ...d }) });
  const setSupply = (fn: (s: SupplyBlock) => SupplyBlock) => setSpecs((s) => ({ ...s, supply: fn(s.supply ?? {}) }));
  const [hsnValue, setHsnValue, hsnMeta] = useDraft(`${draftKey}:hsn`, hsn, { base: hsn, hasContent: (h) => h !== hsn });
  // Row edits keyed by SKU, merged over the server variants on render. An
  // entry whose qty/ws/loc equal the server row is pruned (on restore and
  // after every refresh) so a saved row drops out once the refresh confirms
  // it — pruning on click would flash the old values until the refresh lands.
  type RowEdit = { qty: string; ws: string; loc: string; stockNote: string };
  const rowSeed = (v: VariantRow): RowEdit => ({ qty: String(v.current_qty), ws: String(v.wholesale_price), loc: v.location ?? "", stockNote: "" });
  const rowEdited = (r: RowEdit, v: VariantRow) => { const s = rowSeed(v); return r.qty !== s.qty || r.ws !== s.ws || r.loc !== s.loc; };
  const pruneRows = (e: Record<string, RowEdit>) => {
    const kept = Object.entries(e).filter(([sku, r]) => { const v = variants.find((x) => x.sku === sku); return !!v && rowEdited(r, v); });
    return kept.length === Object.keys(e).length ? e : Object.fromEntries(kept);
  };
  const [rowEdits, setRowEdits, rowsMeta] = useDraft<Record<string, RowEdit>>(`${draftKey}:rows`, {}, {
    base: JSON.stringify(variants.map((v) => [v.sku, rowSeed(v)])),
    hasContent: (e) => Object.keys(pruneRows(e)).length > 0,
    onRestore: pruneRows,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRowEdits(pruneRows); }, [variants]);
  const rows = variants.map((v) => ({ ...v, ...rowSeed(v), ...rowEdits[v.sku], savedQty: Number(v.current_qty) || 0 }));
  const setRow = (v: VariantRow & RowEdit, patch: Partial<RowEdit>) =>
    setRowEdits((e) => ({ ...e, [v.sku]: { ...(e[v.sku] ?? { qty: v.qty, ws: v.ws, loc: v.loc, stockNote: v.stockNote }), ...patch } }));
  const rowsRestored = rowsMeta.restored && Object.keys(rowEdits).length > 0;

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }
  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string, onOk?: () => void) {
    startTransition(async () => {
      const r = await fn();
      flash(r.ok ? done : r.error ?? "Failed");
      if (r.ok) { onOk?.(); router.refresh(); }
    });
  }

  // The cost the autos below stand on: what is being typed, or — blank, or a
  // stray 0 the server would refuse — the cost already stored. Same rule
  // savePricing applies, so the preview cannot promise a price the save
  // won't produce.
  const costTyped = pricing.lastCost.trim();
  const costEntered = costTyped !== "" && costTyped !== costSeed ? Number(pricing.lastCost) : null;
  const costZeroed = costEntered != null && !(costEntered > 0);
  const previewCost = costEntered && costEntered > 0 ? costEntered : lastCost;

  // Previews come from the same helpers savePricing uses, so what the screen
  // promises is exactly what lands. A cost nobody has pinned is still
  // sheet-synced and can move between visits (see src/lib/pricing.ts) — until
  // it is typed here, which locks it against that sync.
  const previewAutoMrp = autoMrpFrom(previewCost, clampMultiplier(Number(pricing.markupMultiplier), DEFAULT_MARKUP_MULTIPLIER));
  const effectiveMrp = pricing.mrpOverride ? Number(pricing.mrpOverride) : previewAutoMrp ?? design.autoMrp;
  const previewAutoWholesale = autoWholesaleFrom(previewCost, clampMultiplier(Number(pricing.wholesaleMultiplier), DEFAULT_WHOLESALE_MULTIPLIER));
  const effectiveWholesale = pricing.wholesaleOverride ? Number(pricing.wholesaleOverride) : previewAutoWholesale ?? design.autoWholesale;
  // Mirrors the server rule in savePricing: an auto price is only pushed onto
  // every size when the sizes already agree.
  const willFlatten = variants.length > 0 && !!effectiveWholesale && (!!pricing.wholesaleOverride || wsUniform);

  const section = (title: string) => (
    <div className="font-body uppercase mt-6" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>{title}</div>
  );
  const inputStyle = { fontSize: 12.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" } as const;

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl pb-16">
      <BackLink fallback={`/admin/studio/${board.id}`} fallbackLabel="Workbench" />
      <h1 className="font-mono mt-3" style={{ fontSize: 19, fontWeight: 700, color: palette.black }}>{board.baseSku} · {board.color}</h1>
      <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>{board.title ?? "—"} · Product Master</div>
      {(specsMeta.restored || pricingMeta.restored || hsnMeta.restored || rowsRestored) && (
        <div className="mt-4 flex flex-col gap-1">
          <DraftNotice meta={specsMeta} label="Specs draft restored" />
          <DraftNotice meta={pricingMeta} label="Pricing draft restored" />
          <DraftNotice meta={hsnMeta} label="HSN draft restored" />
          {rowsRestored && <DraftNotice meta={rowsMeta} label="Size rows draft restored" />}
        </div>
      )}

      {/* Specs */}
      {section("Specs")}
      <div className="mt-2 p-3.5 flex flex-col gap-2" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        {(["fabric", "handwork"] as const).map((f) => (
          <label key={f} className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>{f}</span>
            <input value={specs[f]} onChange={(e) => setSpecs((s) => ({ ...s, [f]: e.target.value }))} className="w-full mt-1 font-body" style={inputStyle} />
          </label>
        ))}
        {/* Ansh (14 Sep) — origin is two options, not free text. The stored
            values are machine tokens; only these labels are ever shown, and
            the copy prompt renders the same ones. */}
        <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Origin</span>
          <select value={specs.origin} onChange={(e) => setSpecs((s) => ({ ...s, origin: e.target.value }))} className="w-full mt-1 font-body" style={inputStyle}>
            <option value="">Not set</option>
            {ORIGIN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Colour</span>
          <input
            value={specs.colorName}
            onChange={(e) => setSpecs((s) => ({ ...s, colorName: e.target.value }))}
            placeholder={`the name a customer would say — e.g. Champagne Gold (code ${board.color})`}
            className="w-full mt-1 font-body"
            style={inputStyle}
          />
        </label>
        <label className="flex items-center gap-2 mt-1 font-body" style={{ fontSize: 12.5, color: palette.black }}>
          <input type="checkbox" checked={specs.specsVerified} onChange={(e) => setSpecs((s) => ({ ...s, specsVerified: e.target.checked }))} style={{ accentColor: palette.goldDeep }} />
          Confirmed by Rakesh
        </label>
        <button type="button" disabled={pending} onClick={() => run(() => saveSpecs(board.id, specs), "Specs saved", specsMeta.clear)} className="self-start font-body uppercase disabled:opacity-40" style={{ fontSize: 9, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 12px" }}>
          Save specs &amp; supply
        </button>
      </div>

      {/* Pricing */}
      {section("Pricing")}
      <div className="mt-2 p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <div className="grid grid-cols-2 gap-3">
          {/* Ansh (20 Sep): "Ayushi at times does not know the prices" when the
              delivery is logged, and a zero cost leaves both autos dead — so
              the figure both prices stand on is typed here too. Saved by the
              same button; left as loaded it is not written at all. */}
          <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Last cost ₹</span>
            <input
              type="number" inputMode="decimal" min="0" step="any"
              value={pricing.lastCost}
              disabled={variants.length === 0}
              placeholder={variants.length === 0 ? "—" : "not known yet"}
              onChange={(e) => setPricing((s) => ({ ...s, lastCost: e.target.value }))}
              className="w-full mt-1 font-body disabled:opacity-50"
              style={inputStyle}
            />
            {/* Where the number came from — the label used to claim
                "receipts/sheet", which stops being true the moment someone
                types one here. */}
            <div className="mt-1" style={{ fontSize: 9.5, lineHeight: 1.5 }}>
              {/* With no size SKUs the box is disabled, and saying "type it"
                  next to a box nobody can type in is how this read as broken
                  (Ansh, 20 Sep, on DD-SUT-PLZ-051 · PNK). The cost is stored
                  per size SKU — product_vendor_info is keyed by sku — so a
                  colour whose delivery was never saved has nowhere to put one.
                  Same wording as the wholesale price below, which already
                  said this. */}
              {variants.length === 0
                ? <span style={{ color: palette.goldDeep }}>No size variants yet — the cost is stored against each size SKU, so there is nowhere to put it. <Link href={withFrom(`/admin/receipts/new?design=${board.id}`, `/admin/studio/master/${board.id}`)} style={{ textDecoration: "underline", color: palette.goldDeep }}>Log the delivery</Link> for this colour and its sizes are minted.</span>
                : costEntered && costEntered > 0
                ? <span style={{ color: palette.goldDeep }}>Saving pins this on all {variants.length} size{variants.length === 1 ? "" : "s"} — the sheet sync stops touching it.</span>
                : costZeroed
                  ? <span style={{ color: palette.goldDeep }}>That is not a cost — saving ignores it and {lastCost > 0 ? `keeps ${formatINR(lastCost)}` : "leaves it unset"}.</span>
                  : lastCostLocked
                    ? <span>Set by hand here. A new receipt still updates it; the sheet does not.</span>
                    : lastCost > 0
                      ? <span>From receipts/the sheet — the 10-min sync can still move it.</span>
                      : <span>No cost recorded yet — type it and both prices below follow.</span>}
            </div>
          </label>
          <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Tier multiplier ({design.tier})</span>
            <input type="number" step="0.1" min="1" max="10" value={pricing.markupMultiplier} onChange={(e) => setPricing((s) => ({ ...s, markupMultiplier: Number(e.target.value) }))} className="w-full mt-1 font-body" style={inputStyle} />
          </label>
          <div className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Auto-MRP (₹…99)</span>
            <div className="font-display mt-1" style={{ fontSize: 16, fontWeight: 600, color: palette.goldDeep }}>{previewAutoMrp ? formatINR(previewAutoMrp) : "needs a cost"}</div>
          </div>
          <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>MRP override</span>
            <input type="number" min="0" value={pricing.mrpOverride} placeholder="—" onChange={(e) => setPricing((s) => ({ ...s, mrpOverride: e.target.value }))} className="w-full mt-1 font-body" style={inputStyle} />
          </label>
        </div>
        <div className="font-body mt-2" style={{ fontSize: 11, color: palette.softBlack }}>
          Effective MRP: <b style={{ color: palette.black }}>{effectiveMrp ? formatINR(Number(effectiveMrp)) : "—"}</b>
          {sheetMrp > 0 && <span style={{ color: palette.mutedGreige }}> · sheet says {formatINR(sheetMrp)} (live until cutover)</span>}
        </div>

        {/* The buyer-facing price, next to the MRP — one place for both, and
            the same multiplier/override shape so the two read as siblings
            (Ansh, 14 Sep: nobody should be doing this arithmetic by hand). */}
        <div className="mt-4 pt-3" style={{ borderTop: "1px solid rgba(26,26,26,0.12)" }}>
          <div className="grid grid-cols-2 gap-3">
            <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
              <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Wholesale multiplier</span>
              <input type="number" step="0.05" min="1" max="10" value={pricing.wholesaleMultiplier} onChange={(e) => setPricing((s) => ({ ...s, wholesaleMultiplier: Number(e.target.value) }))} className="w-full mt-1 font-body" style={inputStyle} />
            </label>
            <div className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
              <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Auto-wholesale (₹…50)</span>
              <div className="font-display mt-1" style={{ fontSize: 16, fontWeight: 600, color: palette.goldDeep }}>{previewAutoWholesale ? formatINR(previewAutoWholesale) : "needs a cost"}</div>
            </div>
            <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
              <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Wholesale override</span>
              <input type="number" inputMode="decimal" min="0" step="any" value={pricing.wholesaleOverride} placeholder="—" onChange={(e) => setPricing((s) => ({ ...s, wholesaleOverride: e.target.value }))} className="w-full mt-1 font-body" style={inputStyle} />
            </label>
          </div>
          <div className="font-body mt-2" style={{ fontSize: 11, color: palette.softBlack }}>
            Effective wholesale: <b style={{ color: palette.black }}>{effectiveWholesale ? formatINR(Number(effectiveWholesale)) : "—"}</b>
          </div>
          <div className="font-body mt-1.5" style={{ fontSize: 10.5, color: palette.mutedGreige, lineHeight: 1.5 }}>
            {variants.length === 0
              ? "No size variants yet — log a delivery first."
              : willFlatten
                ? `Saving applies it to all ${variants.length} size${variants.length === 1 ? "" : "s"}. Buyers see this price; it prints on the tag.`
                : `Sizes are priced differently right now (${wsPrices.map((p) => formatINR(p)).join(" · ")}), so saving leaves them alone. Type a wholesale override to put one price on every size, or price each size in Sizes below.`}
          </div>
        </div>

        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => savePricing(board.id, {
            markupMultiplier: Number(pricing.markupMultiplier),
            mrpOverride: pricing.mrpOverride ? Number(pricing.mrpOverride) : null,
            wholesaleMultiplier: Number(pricing.wholesaleMultiplier),
            wholesaleOverride: pricing.wholesaleOverride ? Number(pricing.wholesaleOverride) : null,
            // null = leave the stored cost alone. Only a box that was actually
            // changed sends a number, so re-saving a multiplier never locks a
            // cost the user never looked at.
            lastCost: costEntered,
          }), willFlatten ? `Pricing saved on ${variants.length} size${variants.length === 1 ? "" : "s"}` : "Pricing saved", pricingMeta.clear)}
          className="mt-3 font-body uppercase disabled:opacity-40"
          style={{ fontSize: 9, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 12px" }}
        >
          Save pricing
        </button>

        {/* Ansh (31 Jul): one HSN across every size of the design. */}
        <div className="flex items-end gap-2 mt-3 flex-wrap">
          <label className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
            <span className="uppercase" style={{ letterSpacing: "0.14em" }}>HSN (all sizes)</span>
            <div><HsnInput value={hsnValue} onChange={setHsnValue} options={hsnOptions} style={{ width: 110 }} /></div>
          </label>
          <button type="button" disabled={pending || hsnValue === hsn} onClick={() => run(() => saveDesignHsn(board.id, board.baseSku, board.color, hsnValue), "HSN saved on all sizes", hsnMeta.clear)} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "8px 12px" }}>
            Save HSN
          </button>
        </div>
      </div>

      {/* Supplier availability — editable here since 12 Sep; the separate
          cost-free specs view it used to live on is gone (floor scope was
          never built, so both screens were admin-only anyway). Saved by the
          "Save specs & supply" button above, which writes this same draft. */}
      {section("Supplier availability")}
      <div className="mt-2 p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <div className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Do they keep this in stock, make it to order, or both?</span>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {(["ready_stock", "made_to_order", "both"] as const).map((m) => {
            const on = (specs.supply as SupplyBlock).supplyMode === m;
            return (
              <button key={m} type="button" onClick={() => setSupply((s) => ({ ...s, supplyMode: on ? "" : m }))} className="font-body" style={{ fontSize: 11.5, padding: "9px 12px", border: `1px solid ${on ? palette.black : "rgba(26,26,26,0.15)"}`, background: on ? palette.black : "transparent", color: on ? palette.ivory : palette.softBlack }}>
                {m.replace("_", " ")}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          {([
            ["vendorStockQty", "Roughly how many ready?"],
            ["makingDays", "Days to make it?"],
            ["makingMoq", "Vendor's minimum order"],
            ["deliveryDays", "Days in transit"],
          ] as const).map(([k, labelText]) => (
            <label key={k} className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
              <span className="uppercase" style={{ letterSpacing: "0.14em" }}>{labelText}</span>
              <input
                type="number" min="0"
                value={(specs.supply as SupplyBlock)[k] ?? ""}
                onChange={(e) => setSupply((s) => ({ ...s, [k]: e.target.value === "" ? null : Number(e.target.value) }))}
                className="w-full mt-1 font-body" style={inputStyle}
              />
            </label>
          ))}
        </div>
        <label className="font-body block mt-3" style={{ fontSize: 10, color: palette.mutedGreige }}>
          <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Anything else about supply</span>
          <input
            value={(specs.supply as SupplyBlock).supplyNote ?? ""}
            onChange={(e) => setSupply((s) => ({ ...s, supplyNote: e.target.value }))}
            className="w-full mt-1 font-body" style={inputStyle}
          />
        </label>
        {(specs.supply as SupplyBlock).makingMoq != null && (
          <div className="font-body mt-2" style={{ fontSize: 11, color: palette.goldDeep }}>
            Vendor makes minimum {(specs.supply as SupplyBlock).makingMoq} — internal only; raise the buyer MOQ if it should be passed on.
          </div>
        )}
        <div className="flex items-center gap-3 mt-3">
          <Link href={`/admin/receipts?q=${encodeURIComponent(board.baseSku)}`} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}>
            Receipts
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
        {rows.map((v) => (
          <div key={v.sku} className="flex items-center gap-2 p-2.5 flex-wrap" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
            {/* w-full on phones: the fixed-width inputs used to squeeze the
                SKU to nothing in the flex-wrap (Ansh, 4 Sep) — give it its own
                line below sm and let it share the row on wider screens. */}
            <span className="font-mono w-full sm:w-auto sm:flex-1 sm:min-w-0 truncate" style={{ fontSize: 11, fontWeight: 600, color: palette.black }}>{v.sku}</span>
            <label className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>
              qty <input type="number" min="0" value={v.qty} onChange={(e) => setRow(v, { qty: e.target.value })} className="font-body ml-1" style={{ ...inputStyle, width: 64, padding: "5px 7px" }} />
            </label>
            <label className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>
              wholesale ₹ <input type="number" min="0" value={v.ws} onChange={(e) => setRow(v, { ws: e.target.value })} className="font-body ml-1" style={{ ...inputStyle, width: 84, padding: "5px 7px" }} />
            </label>
            <label className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>
              kept at <input value={v.loc} placeholder="Rack B2…" onChange={(e) => setRow(v, { loc: e.target.value })} className="font-body ml-1" style={{ ...inputStyle, width: 96, padding: "5px 7px" }} />
            </label>
            <button type="button" disabled={pending} onClick={() => run(() => saveVariant(v.sku, { currentQty: Number(v.qty) || 0, wholesalePrice: Number(v.ws) || 0, stockNote: v.stockNote, location: v.loc }), `${v.sku} saved`)} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "6px 9px" }}>
              Save
            </button>
            <button type="button" onClick={() => setResetFor((cur) => (cur === v.sku ? null : v.sku))} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.1em", color: palette.mutedGreige, padding: "6px 4px" }} title="Declare a counted quantity">
              Set stock
            </button>

            {/* §10.1 — a manual stock change is a movement and needs a note. */}
            {Number(v.qty) !== v.savedQty && (
              <input
                value={v.stockNote}
                onChange={(e) => setRow(v, { stockNote: e.target.value })}
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

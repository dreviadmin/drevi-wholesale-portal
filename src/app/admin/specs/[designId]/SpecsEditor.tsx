"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ImageOff } from "lucide-react";
import { BackLink, withFrom } from "@/components/BackLink";
import { DraftNotice } from "@/components/DraftNotice";
import { KeyboardInset } from "@/components/KeyboardInset";
import { ZoomImage } from "@/components/Lightbox";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { supplyAge } from "@/lib/availability";
import { useDraft } from "@/lib/useDraft";
import { saveSpecsAndSupply } from "./actions";
import type { SupplyBlock } from "@/app/admin/receipts/new/delivery-actions";

// Retrofit R4 §6.2 — descriptive fields + supply, plus (11 Sep) ONE buyer-
// visible wholesale price for every size. NO cost or MRP on this screen; it is
// the one Rakesh uses on the shared counter device.

interface DesignFields {
  id: string; baseSku: string; color: string; title: string | null;
  category: string | null; subCategory: string | null;
  /** Vocab names (raw value when unresolved); codes only when they resolved. */
  categoryLabel: string | null; subCategoryLabel: string | null;
  categoryCode: string | null; subCategoryCode: string | null;
  /** Vocab name for the SKU colour code — the Colour placeholder. */
  colorVocabName: string | null;
  fabric: string; handwork: string; origin: string; colorName: string;
  specsVerified: boolean; identRef: string | null;
  /** sku + wholesale price only — never cost. */
  variants: { sku: string; wholesalePrice: number }[];
  supply: SupplyBlock; supplyUpdatedAt: string | null; supplyUpdatedBy: string | null;
  /** designs.updated_at — the draft's baseline, so a draft older than the row is flagged. */
  updatedAt: string | null;
}

// Ansh (3 Sep): every spec field explains itself — tap ⓘ for what to enter.
const FIELD_HELP: Record<string, string> = {
  Fabric: "The main cloth the garment is cut from — e.g. Shimmer Georgette, Velvet, Raw Silk. If two fabrics matter, name the body first: \"Georgette, Satin lining\".",
  Handwork: "The decoration technique — e.g. Zari embroidery, Sequin work, Mirror + thread, Cutdana. Name what a customer would notice, not the stitch count.",
  Origin: "Where the piece is made or the craft tradition it follows — e.g. Surat, Lucknowi, Banarasi. Leave empty if unknown; don't guess.",
  Colour: "The colour as a customer would say it — e.g. Champagne Gold, Powder Blue, Rani Pink. The SKU code stays as-is; this name feeds the AI copy and photos.",
  "Wholesale price": "The per-piece price a wholesale buyer pays, in ₹ — one price for every size of this design. Buyers see it in the catalog and it prints on the tag. Cost and MRP are not here; they live in the Product Master.",
};

// Size is the segment before the colour suffix (…-SIZE-COLOUR).
const sizeOf = (sku: string) => { const p = sku.split("-"); return p.length >= 2 ? p[p.length - 2] : sku; };

export function SpecsEditor({ design }: { design: DesignFields }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [help, setHelp] = useState<string | null>(null);

  const prices = design.variants.map((v) => v.wholesalePrice);
  const noVariants = prices.length === 0;
  const uniform = !noVariants && prices.every((p) => p === prices[0]);
  // Pre-fill only when every size agrees on a real price — otherwise blank,
  // and blank is a no-op on save so nothing is flattened by accident.
  const initialPrice = uniform && prices[0] > 0 ? String(prices[0]) : "";

  // Draft autosave — an unsaved edit survives closing the app / navigating
  // away. Seeded from the server row; a draft written against an older
  // updated_at is flagged, never silently applied. Cleared on a successful save.
  const seed = {
    fields: {
      fabric: design.fabric, handwork: design.handwork, origin: design.origin,
      colorName: design.colorName, specsVerified: design.specsVerified,
    },
    supply: design.supply,
    price: initialPrice,
  };
  const seedSig = JSON.stringify(seed);
  const [draft, setDraft, draftMeta] = useDraft(`drevi:draft:specs:${design.id}`, seed, {
    base: design.updatedAt ?? seedSig,
    hasContent: (d) => JSON.stringify(d) !== seedSig,
    onRestore: (d) => ({ ...seed, ...d }),
  });
  const { fields, supply, price } = draft;
  const setFields = (fn: (f: typeof seed.fields) => typeof seed.fields) => setDraft((d) => ({ ...d, fields: fn(d.fields) }));
  const setSupply = (fn: (s: SupplyBlock) => SupplyBlock) => setDraft((d) => ({ ...d, supply: fn(d.supply) }));
  const setPrice = (p: string) => setDraft((d) => ({ ...d, price: p }));
  const masterHref = withFrom(`/admin/studio/master/${design.id}`, `/admin/specs/${design.id}`);
  const codes = [design.categoryCode, design.subCategoryCode].filter(Boolean).join("-");

  const input = { fontSize: 14, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "11px 12px", width: "100%" } as const;
  const label = (t: string) => (
    <span className="font-body uppercase block" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige, marginBottom: 4 }}>
      {t}
      {FIELD_HELP[t] && (
        <button
          type="button"
          aria-label={`What to enter for ${t}`}
          onClick={() => setHelp((h) => (h === t ? null : t))}
          className="font-body"
          style={{ marginLeft: 6, width: 15, height: 15, borderRadius: "50%", border: `1px solid ${help === t ? palette.goldDeep : "rgba(26,26,26,0.3)"}`, color: help === t ? palette.goldDeep : palette.mutedGreige, fontSize: 9.5, lineHeight: "13px", textTransform: "none" }}
        >
          i
        </button>
      )}
      {help === t && (
        <span className="font-body block mt-1" style={{ fontSize: 11, lineHeight: 1.55, color: palette.softBlack, letterSpacing: 0, textTransform: "none", fontWeight: 400, background: "rgba(196,163,90,0.12)", padding: "7px 9px" }}>
          {FIELD_HELP[t]}
        </span>
      )}
    </span>
  );
  const masterLink = (text: string) => (
    <Link href={masterHref} style={{ color: palette.goldDeep, borderBottom: `1px solid ${palette.gold}` }}>{text}</Link>
  );

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  function save() {
    // Blank or unchanged → null → the server leaves every size's price alone.
    const raw = price.trim();
    let wholesalePrice: number | null = null;
    if (raw !== "" && !(initialPrice !== "" && Number(raw) === Number(initialPrice))) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { flash("Wholesale price must be a number ≥ 0"); return; }
      wholesalePrice = n;
    }
    startTransition(async () => {
      const r = await saveSpecsAndSupply(design.id, { ...fields, supply, wholesalePrice });
      flash(r.ok ? "Saved" : r.error ?? "Failed");
      if (r.ok) draftMeta.clear();
      if (r.ok || r.partial) router.refresh();
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-xl pb-32">
      <BackLink fallback="/admin/studio" fallbackLabel="Studio" />

      <div className="flex items-start gap-3 mt-4">
        {design.identRef ? (
          <ZoomImage src={`/api/drive-photo?id=${encodeURIComponent(design.identRef)}&s=600`} alt="ident" width={84} height={105} />
        ) : (
          <span className="flex items-center justify-center flex-shrink-0" style={{ width: 84, height: 105, background: palette.ivoryDeep }}><ImageOff size={16} color={palette.mutedGreige} /></span>
        )}
        <div className="min-w-0">
          <h1 className="font-mono" style={{ fontSize: 17, fontWeight: 700, color: palette.black }}>{design.baseSku}·{design.color}</h1>
          <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>{design.title ?? "—"}</div>
          <div className="font-body mt-0.5" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
            {design.categoryLabel ?? "—"}{design.subCategoryLabel ? ` · ${design.subCategoryLabel}` : ""}
            {codes && <span className="font-mono" style={{ fontSize: 9.5, marginLeft: 6, opacity: 0.8 }}>{codes}</span>}
          </div>
        </div>
      </div>
      {draftMeta.restored && <div className="mt-4"><DraftNotice meta={draftMeta} /></div>}

      <div className="font-body uppercase mt-6" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Specs</div>
      <div className="mt-2 p-3.5 flex flex-col gap-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <label className="block">{label("Fabric")}<input value={fields.fabric} onChange={(e) => setFields((f) => ({ ...f, fabric: e.target.value }))} placeholder="e.g. Shimmer Georgette" className="font-body" style={input} /></label>
        <label className="block">{label("Handwork")}<input value={fields.handwork} onChange={(e) => setFields((f) => ({ ...f, handwork: e.target.value }))} placeholder="e.g. Zari + sequin embroidery" className="font-body" style={input} /></label>
        <label className="block">{label("Origin")}<input value={fields.origin} onChange={(e) => setFields((f) => ({ ...f, origin: e.target.value }))} placeholder="e.g. Surat" className="font-body" style={input} /></label>
        <label className="block">{label("Colour")}<input value={fields.colorName} onChange={(e) => setFields((f) => ({ ...f, colorName: e.target.value }))} placeholder={design.colorVocabName ? `${design.colorVocabName} (code ${design.color})` : `e.g. Champagne Gold (code ${design.color})`} className="font-body" style={input} /></label>
        <div>
          <label className="block">
            {label("Wholesale price")}
            <input type="number" inputMode="decimal" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={noVariants ? "" : "₹ per piece, all sizes"} disabled={noVariants} className="font-body disabled:opacity-40" style={input} />
          </label>
          <div className="font-body mt-1" style={{ fontSize: 10, color: palette.mutedGreige, lineHeight: 1.6 }}>
            {noVariants ? (
              "No size variants yet — log a delivery first."
            ) : uniform ? (
              prices[0] > 0 ? `Applies to ${prices.length} size${prices.length === 1 ? "" : "s"}.` : `Not set yet — applies to ${prices.length} size${prices.length === 1 ? "" : "s"}.`
            ) : (
              <>
                Sizes are priced differently: {design.variants.map((v) => `${sizeOf(v.sku)} ${formatINR(v.wholesalePrice)}`).join(" · ")}. Saving a price here sets every size to that price — for per-size prices use the {masterLink("Product Master")}.
              </>
            )}
          </div>
        </div>
        <label className="flex items-center gap-2.5 font-body" style={{ fontSize: 14, color: palette.black }}>
          <input type="checkbox" checked={fields.specsVerified} onChange={(e) => setFields((f) => ({ ...f, specsVerified: e.target.checked }))} style={{ accentColor: palette.goldDeep, width: 18, height: 18 }} />
          Confirmed by Rakesh
        </label>
      </div>

      <div className="flex items-baseline justify-between mt-6">
        <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Supplier availability</span>
        <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>{supplyAge(design.supplyUpdatedAt)?.label ?? "never recorded"}</span>
      </div>
      <div className="mt-2 p-3.5 flex flex-col gap-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <div>
          {label("Do they keep this in stock, make it to order, or both?")}
          <div className="flex flex-wrap gap-1.5">
            {(["ready_stock", "made_to_order", "both", "discontinued"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setSupply((s) => ({ ...s, supplyMode: s.supplyMode === m ? "" : m }))} className="font-body" style={{ fontSize: 11.5, padding: "9px 12px", border: `1px solid ${supply.supplyMode === m ? palette.black : "rgba(26,26,26,0.15)"}`, background: supply.supplyMode === m ? palette.black : "transparent", color: supply.supplyMode === m ? palette.ivory : palette.softBlack }}>
                {m.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">{label("Roughly how many ready?")}<input type="number" min="0" value={supply.vendorStockQty ?? ""} onChange={(e) => setSupply((s) => ({ ...s, vendorStockQty: e.target.value === "" ? null : Number(e.target.value) }))} className="font-body" style={input} /></label>
          <label className="block">{label("Days to make it?")}<input type="number" min="0" value={supply.makingDays ?? ""} onChange={(e) => setSupply((s) => ({ ...s, makingDays: e.target.value === "" ? null : Number(e.target.value) }))} className="font-body" style={input} /></label>
          <label className="block">{label("Minimum pieces per run?")}<input type="number" min="1" value={supply.makingMoq ?? ""} onChange={(e) => setSupply((s) => ({ ...s, makingMoq: e.target.value === "" ? null : Number(e.target.value) }))} className="font-body" style={input} /></label>
          <label className="block">{label("Days to reach us?")}<input type="number" min="0" value={supply.deliveryDays ?? ""} onChange={(e) => setSupply((s) => ({ ...s, deliveryDays: e.target.value === "" ? null : Number(e.target.value) }))} className="font-body" style={input} /></label>
        </div>
        <label className="block">{label("Anything else")}<input value={supply.supplyNote ?? ""} onChange={(e) => setSupply((s) => ({ ...s, supplyNote: e.target.value }))} placeholder="e.g. teal only, red discontinued" className="font-body" style={input} /></label>
        <div className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          Minimum run is internal — it guides our buyer MOQ and is never shown to a buyer.
        </div>
      </div>

      <button type="button" disabled={pending} onClick={save} className="mt-5 w-full font-body uppercase disabled:opacity-40" style={{ fontSize: 11.5, letterSpacing: "0.18em", background: palette.black, color: palette.ivory, padding: "15px 0" }}>
        Save specs &amp; supply
      </button>
      <div className="font-body mt-3" style={{ fontSize: 10, color: palette.mutedGreige, lineHeight: 1.6 }}>
        Cost and MRP live in the {masterLink("Product Master")} — this screen carries only what a buyer can already see, so it can be used on the shared counter device.
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2 flex items-center gap-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
          <Check size={13} color={palette.gold} /> {toast}
        </div>
      )}
      <KeyboardInset />
    </div>
  );
}

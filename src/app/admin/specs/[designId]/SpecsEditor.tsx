"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Check, ImageOff } from "lucide-react";
import { KeyboardInset } from "@/components/KeyboardInset";
import { ZoomImage } from "@/components/Lightbox";
import { palette } from "@/lib/palette";
import { saveSpecsAndSupply } from "./actions";
import type { SupplyBlock } from "@/app/admin/receipts/new/delivery-actions";

// Retrofit R4 §6.2 — descriptive fields + supply only. NO pricing anywhere on
// this screen; it is the one Rakesh uses on the shared counter device.

interface DesignFields {
  id: string; baseSku: string; color: string; title: string | null;
  category: string | null; subCategory: string | null;
  fabric: string; handwork: string; origin: string;
  specsVerified: boolean; identRef: string | null;
  supply: SupplyBlock; supplyUpdatedAt: string | null; supplyUpdatedBy: string | null;
}

function relativeAge(iso: string | null): string {
  if (!iso) return "never recorded";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "updated today";
  if (days === 1) return "updated yesterday";
  if (days < 30) return `updated ${days} days ago`;
  const months = Math.round(days / 30);
  return `updated ${months} month${months === 1 ? "" : "s"} ago`;
}

export function SpecsEditor({ design }: { design: DesignFields }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [fields, setFields] = useState({
    fabric: design.fabric, handwork: design.handwork, origin: design.origin,
    colorName: "", specsVerified: design.specsVerified,
  });
  const [supply, setSupply] = useState<SupplyBlock>(design.supply);

  const input = { fontSize: 14, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "11px 12px", width: "100%" } as const;
  const label = (t: string) => (
    <span className="font-body uppercase block" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige, marginBottom: 4 }}>{t}</span>
  );

  function save() {
    startTransition(async () => {
      const r = await saveSpecsAndSupply(design.id, { ...fields, supply });
      setToast(r.ok ? "Saved" : r.error ?? "Failed");
      setTimeout(() => setToast(null), 2400);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-xl pb-32">
      <Link href="/admin/studio" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}>
        <ChevronLeft size={14} /> Studio
      </Link>

      <div className="flex items-start gap-3 mt-4">
        {design.identRef ? (
          <ZoomImage src={`/api/drive-photo?id=${encodeURIComponent(design.identRef)}&s=600`} alt="ident" width={84} height={105} />
        ) : (
          <span className="flex items-center justify-center flex-shrink-0" style={{ width: 84, height: 105, background: palette.ivoryDeep }}><ImageOff size={16} color={palette.mutedGreige} /></span>
        )}
        <div className="min-w-0">
          <h1 className="font-mono" style={{ fontSize: 17, fontWeight: 700, color: palette.black }}>{design.baseSku}·{design.color}</h1>
          <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>{design.title ?? "—"}</div>
          <div className="font-body mt-0.5" style={{ fontSize: 10.5, color: palette.mutedGreige }}>{design.category ?? "—"}{design.subCategory ? ` · ${design.subCategory}` : ""}</div>
        </div>
      </div>

      <div className="font-body uppercase mt-6" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Specs</div>
      <div className="mt-2 p-3.5 flex flex-col gap-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <label className="block">{label("Fabric")}<input value={fields.fabric} onChange={(e) => setFields((f) => ({ ...f, fabric: e.target.value }))} className="font-body" style={input} /></label>
        <label className="block">{label("Handwork")}<input value={fields.handwork} onChange={(e) => setFields((f) => ({ ...f, handwork: e.target.value }))} className="font-body" style={input} /></label>
        <label className="block">{label("Origin")}<input value={fields.origin} onChange={(e) => setFields((f) => ({ ...f, origin: e.target.value }))} className="font-body" style={input} /></label>
        <label className="flex items-center gap-2.5 font-body" style={{ fontSize: 14, color: palette.black }}>
          <input type="checkbox" checked={fields.specsVerified} onChange={(e) => setFields((f) => ({ ...f, specsVerified: e.target.checked }))} style={{ accentColor: palette.goldDeep, width: 18, height: 18 }} />
          Confirmed by Rakesh
        </label>
      </div>

      <div className="flex items-baseline justify-between mt-6">
        <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Supplier availability</span>
        <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>{relativeAge(design.supplyUpdatedAt)}</span>
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
        Pricing lives in the full product master — this screen is deliberately cost-free so it can be used on the shared counter device.
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

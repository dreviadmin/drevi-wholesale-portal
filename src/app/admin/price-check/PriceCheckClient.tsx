"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { ScanLine, Search, X } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { getStockState } from "@/lib/stock";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

const STOCK_LABEL: Record<string, string> = {
  ready: "In stock",
  limited: "Limited edition",
  made_to_order: "Made to order",
  sold_out: "Sold out",
};

export function PriceCheckClient({ products }: { products: WholesaleProduct[] }) {
  const [scanning, setScanning] = useState(false);
  const [current, setCurrent] = useState<WholesaleProduct | null>(null);
  const [recent, setRecent] = useState<WholesaleProduct[]>([]);
  const [query, setQuery] = useState("");

  const bySku = useMemo(
    () => new Map(products.map((p) => [p.sku.trim().toUpperCase(), p])),
    [products],
  );

  function show(p: WholesaleProduct) {
    setCurrent(p);
    setRecent((r) => [p, ...r.filter((x) => x.sku !== p.sku)].slice(0, 8));
    setQuery("");
  }

  // The scanner overlay shows this feedback live, so the price is readable
  // without closing the camera — staff can sweep a whole rack.
  function handleScan(text: string): ScanFeedback {
    const p = bySku.get(text.trim().toUpperCase());
    if (!p) return { ok: false, message: `${text.trim()} — not in the catalog` };
    show(p);
    // Price first: on narrow screens the tail of the message crops.
    return { ok: true, message: `${formatINR(p.wholesale_price)} — ${p.title ?? p.sku}` };
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => p.sku.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, products]);

  const stock = current ? getStockState(current) : null;

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Price Check</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, color: palette.mutedGreige }}>
        Scan the QR on the tag — the wholesale price shows instantly.
      </p>

      <button
        type="button"
        onClick={() => setScanning(true)}
        className="mt-4 w-full flex items-center justify-center gap-3 font-body uppercase"
        style={{ fontSize: 13, letterSpacing: "0.2em", padding: "18px 0", background: palette.black, color: palette.ivory }}
      >
        <ScanLine size={20} strokeWidth={1.6} /> Scan Tag
      </button>

      <div className="mt-3">
        <div className="flex items-center gap-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px" }}>
          <Search size={15} color={palette.mutedGreige} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Or search name / SKU"
            className="font-body flex-1 bg-transparent outline-none"
            style={{ fontSize: 13, color: palette.black }}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={14} color={palette.mutedGreige} />
            </button>
          )}
        </div>
        {matches.length > 0 && (
          <div style={{ border: "1px solid rgba(26,26,26,0.1)", borderTop: "none" }}>
            {matches.map((p) => (
              <button
                key={p.sku}
                type="button"
                onClick={() => show(p)}
                className="w-full flex items-center gap-3 px-2 py-2 text-left"
                style={{ borderBottom: "1px solid rgba(26,26,26,0.05)", background: palette.ivory }}
              >
                <div className="relative flex-shrink-0" style={{ width: 30, height: 38, background: palette.ivoryDeep }}>
                  {p.image_urls?.[0] && <Image src={p.image_urls[0]} alt="" fill sizes="30px" className="object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-body truncate" style={{ fontSize: 12.5, color: palette.black }}>{p.title ?? p.sku}</div>
                  <div className="font-body" style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.08em" }}>{p.sku}</div>
                </div>
                <span className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{formatINR(p.wholesale_price)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {current && (
        <div className="mt-6 flex gap-4" style={{ background: palette.ivoryDeep, padding: 16 }}>
          <div className="relative flex-shrink-0" style={{ width: 110, height: 138, background: palette.ivory }}>
            {current.image_urls?.[0] && (
              <Image src={current.image_urls[0]} alt={current.title ?? current.sku} fill sizes="110px" className="object-cover" priority />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black, lineHeight: 1.25 }}>
              {current.title ?? current.sku}
            </div>
            <div className="font-body mt-1" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.12em" }}>
              {current.sku}
              {current.color ? ` · ${current.color}` : ""}
              {current.primary_fabric ? ` · ${current.primary_fabric}` : ""}
            </div>
            <div className="font-display mt-3" style={{ fontSize: 30, fontWeight: 700, color: palette.black }}>
              {formatINR(current.wholesale_price)}
            </div>
            <div className="font-body mt-2 flex flex-wrap gap-x-4 gap-y-1" style={{ fontSize: 11, color: palette.softBlack }}>
              {current.min_order_qty != null && <span>MOQ {current.min_order_qty}</span>}
              {stock && (
                <span style={{ color: stock === "sold_out" ? "#9b2c2c" : palette.goldDeep }}>
                  {STOCK_LABEL[stock]}
                  {stock === "made_to_order" && current.restock_days ? ` · ${current.restock_days}d` : ""}
                </span>
              )}
              {stock === "limited" && <span>{current.current_qty} pcs left</span>}
            </div>
          </div>
        </div>
      )}

      {recent.length > 1 && (
        <div className="mt-6">
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Recent checks</div>
          <div className="mt-2 flex flex-col">
            {recent.slice(1).map((p) => (
              <button
                key={p.sku}
                type="button"
                onClick={() => show(p)}
                className="flex items-baseline justify-between py-2 text-left"
                style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}
              >
                <span className="font-body truncate" style={{ fontSize: 12, color: palette.softBlack, paddingRight: 12 }}>{p.title ?? p.sku}</span>
                <span className="font-body flex-shrink-0" style={{ fontSize: 12, color: palette.black, fontWeight: 600 }}>{formatINR(p.wholesale_price)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {scanning && <QrScanner title="Scan tag for price" onScan={handleScan} onClose={() => setScanning(false)} holdFeedback />}
    </div>
  );
}

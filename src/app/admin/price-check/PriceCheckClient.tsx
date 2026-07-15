"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { ScanLine, Search, X, Copy, Check, ImageOff } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { ProductQuickView } from "@/components/ProductQuickView";
import { lookupSkuPhoto } from "./actions";
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

// A scan/search result: either a matched portal product, or a bare SKU that
// isn't on the portal yet (the missing-price items — copy the SKU to price it
// in the sheet).
type Result = { sku: string; product: WholesaleProduct | null };

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function PriceCheckClient({ products, drivePhotos }: { products: WholesaleProduct[]; drivePhotos: boolean }) {
  const [scanning, setScanning] = useState(false);
  const [current, setCurrent] = useState<Result | null>(null);
  const [recent, setRecent] = useState<Result[]>([]);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  // Drive photo for the current SKU (tagging aid). "loading" while fetching,
  // string url when found, null when none. Keyed by sku via the ref guard.
  const [photo, setPhoto] = useState<{ sku: string; url: string | null; loading: boolean }>({ sku: "", url: null, loading: false });
  const photoReq = useRef(0);
  const [lightbox, setLightbox] = useState<string | null>(null); // full-size photo overlay
  const [detail, setDetail] = useState<WholesaleProduct | null>(null); // product detail modal

  // When the shown item has no built-in photo (the new, not-yet-on-portal
  // outfits), pull its photo from the Drive folder so staff can identify it.
  useEffect(() => {
    if (!drivePhotos || !current) { setPhoto({ sku: "", url: null, loading: false }); return; }
    if (current.product?.image_urls?.[0]) { setPhoto({ sku: current.sku, url: null, loading: false }); return; }
    const reqId = ++photoReq.current;
    setPhoto({ sku: current.sku, url: null, loading: true });
    lookupSkuPhoto(current.sku)
      .then((res) => { if (reqId === photoReq.current) setPhoto({ sku: current.sku, url: res.url, loading: false }); })
      .catch(() => { if (reqId === photoReq.current) setPhoto({ sku: current.sku, url: null, loading: false }); });
  }, [current, drivePhotos]);

  const bySku = useMemo(
    () => new Map(products.map((p) => [p.sku.trim().toUpperCase(), p])),
    [products],
  );

  function show(r: Result) {
    setCurrent(r);
    setRecent((list) => [r, ...list.filter((x) => x.sku !== r.sku)].slice(0, 10));
    setQuery("");
  }

  async function doCopy(sku: string) {
    const ok = await copyText(sku);
    if (ok) { setCopied(sku); setTimeout(() => setCopied((c) => (c === sku ? null : c)), 1500); }
  }

  // Scanner overlay feedback — readable without closing the camera.
  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty scan" };
    const p = bySku.get(sku) ?? null;
    show({ sku, product: p });
    // Auto-copy every scanned SKU so a paste into the sheet is instant.
    void copyText(sku);
    setCopied(sku);
    setTimeout(() => setCopied((c) => (c === sku ? null : c)), 1500);
    return p
      ? { ok: true, message: p.wholesale_price > 0 ? `${formatINR(p.wholesale_price)} — ${p.title ?? p.sku}` : `${p.title ?? sku} — price not set · SKU copied` }
      : { ok: true, message: `${sku} · copied` }; // not on portal, but SKU captured
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => p.sku.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, products]);

  const stock = current?.product ? getStockState(current.product) : null;
  const trimmedQuery = query.trim();

  // Drive photo box: fast s500 thumbnail, tap to open a large s1400 view.
  const drivePhotoBox = (sku: string, w: number, h: number) => {
    const ready = photo.sku === sku && photo.url;
    const loading = photo.sku === sku && photo.loading;
    return (
      <button
        type="button"
        onClick={() => ready && setLightbox(`${photo.url}&s=1400`)}
        aria-label={ready ? "Open photo" : "Photo"}
        className="relative flex-shrink-0 flex items-center justify-center"
        style={{ width: w, height: h, background: palette.ivory, cursor: ready ? "zoom-in" : "default", padding: 0, border: "none" }}
      >
        {ready ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${photo.url}&s=500`} alt={sku} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : loading ? (
          <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>Loading photo…</span>
        ) : (
          <div className="flex flex-col items-center gap-1" style={{ color: palette.mutedGreige }}>
            <ImageOff size={20} strokeWidth={1.5} />
            <span className="font-body text-center" style={{ fontSize: 9 }}>No photo</span>
          </div>
        )}
      </button>
    );
  };

  const copyBtn = (sku: string, big = false) => (
    <button
      type="button"
      onClick={() => doCopy(sku)}
      className="flex items-center gap-1.5 font-body uppercase flex-shrink-0"
      style={{
        fontSize: big ? 10 : 9, letterSpacing: "0.14em",
        padding: big ? "9px 14px" : "6px 10px",
        background: copied === sku ? palette.goldDeep : palette.black, color: palette.ivory,
      }}
    >
      {copied === sku ? <Check size={big ? 14 : 12} /> : <Copy size={big ? 14 : 12} />}
      {copied === sku ? "Copied" : "Copy SKU"}
    </button>
  );

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Price Check</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, color: palette.mutedGreige }}>
        Scan a tag — see the price if it’s on the portal, or copy the SKU to add its price in the sheet.
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
            placeholder="Or search / type a SKU"
            autoCapitalize="characters"
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
                onClick={() => show({ sku: p.sku.toUpperCase(), product: p })}
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
                <span className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{p.wholesale_price > 0 ? formatINR(p.wholesale_price) : "—"}</span>
              </button>
            ))}
          </div>
        )}
        {/* Typed a SKU that isn't on the portal? Still let them grab it. */}
        {trimmedQuery !== "" && matches.length === 0 && (
          <button
            type="button"
            onClick={() => show({ sku: trimmedQuery.toUpperCase(), product: null })}
            className="mt-2 flex items-center gap-1.5 font-body"
            style={{ fontSize: 11.5, color: palette.goldDeep, letterSpacing: "0.04em" }}
          >
            <Copy size={12} /> Use “{trimmedQuery.toUpperCase()}” — copy this SKU
          </button>
        )}
      </div>

      {current && (
        current.product ? (
          <div className="mt-6 flex gap-4" style={{ background: palette.ivoryDeep, padding: 16 }}>
            {current.product.image_urls?.[0] ? (
              <button
                type="button"
                onClick={() => setLightbox(current.product!.image_urls![0])}
                aria-label="Enlarge photo"
                className="relative flex-shrink-0"
                style={{ width: 110, height: 138, background: palette.ivory, cursor: "zoom-in", padding: 0, border: "none" }}
              >
                <Image src={current.product.image_urls[0]} alt={current.product.title ?? current.sku} fill sizes="110px" className="object-cover" priority />
              </button>
            ) : (
              // Portal item with no Shopify image — fall back to its Drive photo.
              drivePhotos ? drivePhotoBox(current.sku, 110, 138)
                : <div className="relative flex-shrink-0" style={{ width: 110, height: 138, background: palette.ivory }} />
            )}
            <div className="min-w-0 flex-1">
              <button type="button" onClick={() => setDetail(current.product)} className="text-left">
                <div className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black, lineHeight: 1.25 }}>
                  {current.product.title ?? current.sku}
                </div>
              </button>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="font-body" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.12em" }}>{current.sku}</span>
                {copyBtn(current.sku)}
                <button type="button" onClick={() => setDetail(current.product)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.goldDeep, borderBottom: `1px solid ${palette.gold}` }}>View details</button>
              </div>
              {current.product.wholesale_price > 0 ? (
                <div className="font-display mt-3" style={{ fontSize: 30, fontWeight: 700, color: palette.black }}>
                  {formatINR(current.product.wholesale_price)}
                </div>
              ) : (
                <div className="font-body mt-3" style={{ fontSize: 13, color: palette.goldDeep, fontWeight: 600 }}>
                  Price not set — copy the SKU and add it in the sheet
                </div>
              )}
              <div className="font-body mt-2 flex flex-wrap gap-x-4 gap-y-1" style={{ fontSize: 11, color: palette.softBlack }}>
                {current.product.min_order_qty != null && <span>MOQ {current.product.min_order_qty}</span>}
                {stock && (
                  <span style={{ color: stock === "sold_out" ? "#9b2c2c" : palette.goldDeep }}>
                    {STOCK_LABEL[stock]}
                    {stock === "made_to_order" && current.product.restock_days ? ` · ${current.product.restock_days}d` : ""}
                  </span>
                )}
                {stock === "limited" && <span>{current.product.current_qty} pcs left</span>}
              </div>
            </div>
          </div>
        ) : (
          // Not on the portal yet — the missing-price items. Photo (for
          // tagging) + big SKU + copy (for pricing).
          <div className="mt-6 flex gap-4" style={{ background: palette.ivoryDeep, padding: 16 }}>
            {drivePhotos && drivePhotoBox(current.sku, 132, 165)}
            <div className="min-w-0 flex-1">
              <div className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.18em", color: palette.mutedGreige }}>SKU</div>
              <div className="font-display mt-1" style={{ fontSize: 20, fontWeight: 700, color: palette.black, wordBreak: "break-all" }}>{current.sku}</div>
              <div className="mt-3">{copyBtn(current.sku, true)}</div>
              <p className="font-body mt-3" style={{ fontSize: 11, color: palette.mutedGreige, lineHeight: 1.5 }}>
                Not on the portal yet — copy the SKU to add its price in the sheet.
              </p>
            </div>
          </div>
        )
      )}

      {recent.length > 1 && (
        <div className="mt-6">
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Recent scans</div>
          <div className="mt-2 flex flex-col">
            {recent.slice(1).map((r) => (
              <div key={r.sku} className="flex items-center justify-between gap-2 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <button type="button" onClick={() => show(r)} className="min-w-0 flex-1 text-left">
                  <span className="font-body truncate block" style={{ fontSize: 12, color: palette.softBlack }}>
                    {r.product ? (r.product.title ?? r.sku) : r.sku}
                  </span>
                </button>
                {r.product
                  ? <span className="font-body flex-shrink-0" style={{ fontSize: 12, color: palette.black, fontWeight: 600 }}>{r.product.wholesale_price > 0 ? formatINR(r.product.wholesale_price) : "—"}</span>
                  : <button type="button" onClick={() => doCopy(r.sku)} aria-label={`Copy ${r.sku}`} className="p-1.5 flex-shrink-0">{copied === r.sku ? <Check size={13} color={palette.goldDeep} /> : <Copy size={13} color={palette.mutedGreige} />}</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {detail && <ProductQuickView product={detail} onClose={() => setDetail(null)} readOnly />}

      {scanning && (
        <QrScanner
          title="Scan tag"
          onScan={handleScan}
          onClose={() => setScanning(false)}
          holdFeedback
          caption={drivePhotos ? "Scan a tag — its photo shows below." : "Scan a tag — the SKU copies automatically."}
          extra={
            drivePhotos && current ? (
              <button
                type="button"
                onClick={() => photo.sku === current.sku && photo.url && setLightbox(`${photo.url}&s=1400`)}
                className="w-full flex items-center gap-3"
                style={{ background: "rgba(255,255,255,0.08)", padding: 8, border: "none", cursor: photo.url ? "zoom-in" : "default" }}
              >
                <div className="relative flex-shrink-0 flex items-center justify-center" style={{ width: 70, height: 88, background: "rgba(0,0,0,0.3)" }}>
                  {photo.sku === current.sku && photo.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${photo.url}&s=500`} alt={current.sku} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : photo.sku === current.sku && photo.loading ? (
                    <span className="font-body" style={{ fontSize: 9, color: palette.champagne }}>Loading…</span>
                  ) : (
                    <ImageOff size={18} color={palette.champagne} strokeWidth={1.5} />
                  )}
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <div className="font-body truncate" style={{ fontSize: 12, color: palette.ivory, fontWeight: 600, letterSpacing: "0.04em" }}>{current.sku}</div>
                  <div className="font-body" style={{ fontSize: 9.5, color: palette.champagne }}>
                    {photo.sku === current.sku && photo.url ? "Tap to enlarge · SKU copied" : photo.loading ? "Fetching photo…" : "SKU copied"}
                  </div>
                </div>
              </button>
            ) : null
          }
        />
      )}

      {/* Full-size photo — tap anywhere to close. Lets staff compare the photo
          against the physical outfit while tagging. */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(15,13,12,0.94)", padding: 16 }}
          onClick={() => setLightbox(null)}
          role="button"
          aria-label="Close photo"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="Outfit" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close"
            className="absolute"
            style={{ top: 16, right: 16, color: palette.ivory }}
          >
            <X size={26} />
          </button>
        </div>
      )}
    </div>
  );
}

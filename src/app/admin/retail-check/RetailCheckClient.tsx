"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ScanLine, Search, X, Copy, Check, ImageOff, RefreshCw } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { ProductQuickView } from "@/components/ProductQuickView";
import { ZoomImage } from "@/components/Lightbox";
import { refreshRetailPrices, lookupRetailSkuPhoto } from "./actions";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

// A scan/search result: a portal product, a sheet-only SKU (hidden from the
// wholesale portal but hanging in the shop), or an unknown tag.
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

export function RetailCheckClient({ products, retail, pricesAsOf, drivePhotos }: {
  products: WholesaleProduct[];
  retail: { sku: string; retail_price: number }[];
  pricesAsOf: string | null;
  drivePhotos: boolean;
}) {
  const [scanning, setScanning] = useState(false);
  const [current, setCurrent] = useState<Result | null>(null);
  const [recent, setRecent] = useState<Result[]>([]);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [detail, setDetail] = useState<WholesaleProduct | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(pricesAsOf);
  const [isSyncing, startSync] = useTransition();
  // Retail prices, refreshable in place via the Sync button.
  const [retailBySku, setRetailBySku] = useState<Map<string, number>>(
    () => new Map(retail.map((r) => [r.sku.trim().toUpperCase(), r.retail_price])),
  );

  const [photo, setPhoto] = useState<{ sku: string; url: string | null; loading: boolean }>({ sku: "", url: null, loading: false });
  const photoReq = useRef(0);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const bySku = useMemo(
    () => new Map(products.map((p) => [p.sku.trim().toUpperCase(), p])),
    [products],
  );
  const retailOf = (sku: string): number => retailBySku.get(sku.trim().toUpperCase()) ?? 0;

  // Drive photo fallback for tags whose product has no portal photo.
  useEffect(() => {
    if (!drivePhotos || !current) { setPhoto({ sku: "", url: null, loading: false }); return; }
    if (current.product?.image_urls?.[0]) { setPhoto({ sku: current.sku, url: null, loading: false }); return; }
    const reqId = ++photoReq.current;
    setPhoto({ sku: current.sku, url: null, loading: true });
    lookupRetailSkuPhoto(current.sku)
      .then((res) => { if (reqId === photoReq.current) setPhoto({ sku: current.sku, url: res.url, loading: false }); })
      .catch(() => { if (reqId === photoReq.current) setPhoto({ sku: current.sku, url: null, loading: false }); });
  }, [current, drivePhotos]);

  function show(r: Result) {
    setCurrent(r);
    setRecent((list) => [r, ...list.filter((x) => x.sku !== r.sku)].slice(0, 10));
    setQuery("");
  }

  async function doCopy(sku: string) {
    const ok = await copyText(sku);
    if (ok) { setCopied(sku); setTimeout(() => setCopied((c) => (c === sku ? null : c)), 1500); }
  }

  function doSync() {
    setSyncMsg(null);
    startSync(async () => {
      const res = await refreshRetailPrices();
      if (!res.ok || !res.prices) { setSyncMsg(res.error ?? "Sync failed — try again."); return; }
      // Update in place — the scan on screen refreshes without a reload.
      setRetailBySku(new Map(res.prices.map((r) => [r.sku.trim().toUpperCase(), r.retail_price])));
      if (res.asOf) setAsOf(res.asOf);
    });
  }

  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty scan" };
    const p = bySku.get(sku) ?? null;
    show({ sku, product: p });
    const price = retailOf(sku);
    if (price > 0) return { ok: true, message: `${formatINR(price)} — ${p?.title ?? sku}` };
    if (p || retailBySku.has(sku)) return { ok: true, message: `${p?.title ?? sku} — retail price not set` };
    return { ok: false, message: `${sku} — not found` };
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => p.sku.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, products]);

  const trimmedQuery = query.trim();

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

  const priceBlock = (sku: string) => {
    const price = retailOf(sku);
    return price > 0 ? (
      <div className="font-display mt-3" style={{ fontSize: 30, fontWeight: 700, color: palette.black }}>
        {formatINR(price)}
        <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.goldDeep, marginLeft: 8 }}>Retail</span>
      </div>
    ) : (
      <div className="font-body mt-3" style={{ fontSize: 13, color: palette.goldDeep, fontWeight: 600 }}>
        Retail price not set — add Final MRP in the sheet, then tap Sync Prices
      </div>
    );
  };

  const asOfLabel = asOf
    ? new Date(asOf).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })
    : null;

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Retail Price Check</h1>
          <p className="font-body mt-1" style={{ fontSize: 12, color: palette.mutedGreige }}>
            Scan the tag QR — quote the retail price. Wholesale prices are never shown here.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={doSync}
            disabled={isSyncing}
            className="flex items-center gap-2 font-body uppercase disabled:opacity-60"
            style={{ fontSize: 9.5, letterSpacing: "0.14em", padding: "8px 13px", border: `1px solid ${palette.black}`, color: palette.black, background: "transparent" }}
          >
            <RefreshCw size={13} strokeWidth={1.8} className={isSyncing ? "animate-spin" : undefined} />
            {isSyncing ? "Syncing…" : "Sync Prices"}
          </button>
          {asOfLabel && <span className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>prices as of {asOfLabel}</span>}
        </div>
      </div>
      {syncMsg && <p className="font-body mt-2" style={{ fontSize: 11.5, color: palette.crimsonText }}>{syncMsg}</p>}

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
            {matches.map((p) => {
              const price = retailOf(p.sku);
              return (
                <button
                  key={p.sku}
                  type="button"
                  onClick={() => show({ sku: p.sku.toUpperCase(), product: p })}
                  className="w-full flex items-center gap-3 px-2 py-2 text-left"
                  style={{ borderBottom: "1px solid rgba(26,26,26,0.05)", background: palette.ivory }}
                >
                  <div className="relative flex-shrink-0" style={{ width: 30, height: 38, background: palette.ivoryDeep }}>
                    {p.image_urls?.[0] && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_urls[0]} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-body truncate" style={{ fontSize: 12.5, color: palette.black }}>{p.title ?? p.sku}</div>
                    <div className="font-body" style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.08em" }}>{p.sku}</div>
                  </div>
                  <span className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{price > 0 ? formatINR(price) : "—"}</span>
                </button>
              );
            })}
          </div>
        )}
        {trimmedQuery !== "" && matches.length === 0 && (
          <button
            type="button"
            onClick={() => show({ sku: trimmedQuery.toUpperCase(), product: bySku.get(trimmedQuery.toUpperCase()) ?? null })}
            className="mt-2 flex items-center gap-1.5 font-body"
            style={{ fontSize: 11.5, color: palette.goldDeep, letterSpacing: "0.04em" }}
          >
            <Search size={12} /> Look up “{trimmedQuery.toUpperCase()}”
          </button>
        )}
      </div>

      {current && (
        <div className="mt-6 flex gap-4" style={{ background: palette.ivoryDeep, padding: 16 }}>
          {current.product?.image_urls?.[0] ? (
            <ZoomImage src={current.product.image_urls[0]} alt={current.product.title ?? current.sku} width={110} height={138} />
          ) : drivePhotos ? (
            drivePhotoBox(current.sku, 110, 138)
          ) : (
            <div className="relative flex-shrink-0" style={{ width: 110, height: 138, background: palette.ivory }} />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black, lineHeight: 1.25 }}>
              {current.product?.title ?? current.sku}
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="font-body" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.12em" }}>{current.sku}</span>
              <button
                type="button"
                onClick={() => doCopy(current.sku)}
                className="flex items-center gap-1.5 font-body uppercase flex-shrink-0"
                style={{ fontSize: 9, letterSpacing: "0.14em", padding: "6px 10px", background: copied === current.sku ? palette.goldDeep : palette.black, color: palette.ivory }}
              >
                {copied === current.sku ? <Check size={12} /> : <Copy size={12} />}
                {copied === current.sku ? "Copied" : "Copy SKU"}
              </button>
              {current.product && (
                <button type="button" onClick={() => setDetail(current.product)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.goldDeep, borderBottom: `1px solid ${palette.gold}` }}>
                  View details
                </button>
              )}
            </div>
            {priceBlock(current.sku)}
            {!current.product && !retailBySku.has(current.sku.trim().toUpperCase()) && (
              <p className="font-body mt-2" style={{ fontSize: 11, color: palette.mutedGreige, lineHeight: 1.5 }}>
                Not in the sheet — check the SKU or add the row, then tap Sync Prices.
              </p>
            )}
          </div>
        </div>
      )}

      {recent.length > 1 && (
        <div className="mt-6">
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Recent scans</div>
          <div className="mt-2 flex flex-col">
            {recent.slice(1).map((r) => {
              const price = retailOf(r.sku);
              return (
                <div key={r.sku} className="flex items-center justify-between gap-2 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                  <button type="button" onClick={() => show(r)} className="min-w-0 flex-1 text-left">
                    <span className="font-body truncate block" style={{ fontSize: 12, color: palette.softBlack }}>
                      {r.product?.title ?? r.sku}
                    </span>
                  </button>
                  <span className="font-body flex-shrink-0" style={{ fontSize: 12, color: palette.black, fontWeight: 600 }}>{price > 0 ? formatINR(price) : "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Wholesale prices stay hidden: showPrices={false}. */}
      {detail && <ProductQuickView product={detail} onClose={() => setDetail(null)} readOnly showPrices={false} />}

      {scanning && (
        <QrScanner
          title="Scan tag"
          onScan={handleScan}
          onClose={() => setScanning(false)}
          holdFeedback
          caption="Scan a tag — the retail price shows instantly."
        />
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center"
          style={{ background: "rgba(15,13,12,0.94)", padding: 16 }}
          onClick={() => setLightbox(null)}
          role="button"
          aria-label="Close photo"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="Outfit" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          <button type="button" onClick={() => setLightbox(null)} aria-label="Close" className="absolute" style={{ top: 16, right: 16, color: palette.ivory }}>
            <X size={26} />
          </button>
        </div>
      )}
    </div>
  );
}

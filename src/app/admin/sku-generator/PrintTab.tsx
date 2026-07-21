"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, ScanLine, Minus, Plus, Trash2, Printer, Download, RefreshCw } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { buildRollPdf, printPdf, pdfFileName, DEFAULT_CAL, CAL_KEY, type Calibration, type TrayItem, type PrintDatum } from "./labels";
import type { BaseEntry } from "./SkuGeneratorClient";
import { palette } from "@/lib/palette";

// Print tab (spec §6.2–§6.4): per-device tray, registry picker, bulk add,
// plain / with-price roll labels for the DCode DC421 Pro.
export function PrintTab({ tray, setTray, bases, flash }: {
  tray: TrayItem[];
  setTray: React.Dispatch<React.SetStateAction<TrayItem[]>>;
  bases: BaseEntry[] | null;
  flash: (m: string) => void;
}) {
  const [cal, setCal] = useState<Calibration>(DEFAULT_CAL);
  const [withPrice, setWithPrice] = useState(false);
  const [priceData, setPriceData] = useState<Map<string, PrintDatum> | null>(null);
  const [fetching, setFetching] = useState(false);
  const [building, setBuilding] = useState(false);
  const [pickQuery, setPickQuery] = useState("");
  const [bulk, setBulk] = useState("");
  const [scanning, setScanning] = useState(false);
  const [showCal, setShowCal] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CAL_KEY);
      if (raw) setCal({ ...DEFAULT_CAL, ...JSON.parse(raw) });
    } catch { /* corrupted — defaults */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(CAL_KEY, JSON.stringify(cal)); } catch { /* full */ }
  }, [cal]);

  // Any tray change invalidates fetched price data.
  const trayKey = tray.map((t) => t.sku).join(",");
  useEffect(() => { setPriceData(null); }, [trayKey]);

  const totalLabels = tray.reduce((n, t) => n + t.copies, 0);
  const registrySkus = useMemo(() => new Set((bases ?? []).flatMap((b) => b.variants.map((v) => v.sku))), [bases]);

  const add = (sku: string, copies = 1) => {
    const key = sku.trim().toUpperCase();
    if (!key) return;
    setTray((t) => {
      const ex = t.find((i) => i.sku === key);
      return ex ? t.map((i) => (i.sku === key ? { ...i, copies: i.copies + copies } : i)) : [...t, { sku: key, copies }];
    });
  };

  const pickResults = useMemo(() => {
    if (!bases) return [];
    const q = pickQuery.trim().toUpperCase();
    const variants = bases.flatMap((b) => b.variants.map((v) => ({ ...v, desc: b.desc })));
    if (!q) return variants.slice(0, 10);
    return variants.filter((v) => v.sku.includes(q) || v.desc.toUpperCase().includes(q)).slice(0, 30);
  }, [bases, pickQuery]);

  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty scan" };
    add(sku);
    return { ok: true, message: `${sku} added${registrySkus.size > 0 && !registrySkus.has(sku) ? " (not in registry)" : ""}` };
  }

  function addBulk() {
    const skus = bulk.split(/[\n,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (skus.length === 0) return;
    let unknown = 0;
    for (const s of skus) {
      if (registrySkus.size > 0 && !registrySkus.has(s)) unknown++;
      add(s);
    }
    setBulk("");
    flash(`${skus.length} added${unknown > 0 ? ` · ${unknown} not in the registry (added anyway)` : ""}`);
  }

  const fetchIdRef = useRef(0);
  async function fetchPrices() {
    const fetchId = ++fetchIdRef.current;
    const snapshot = tray.map((t) => t.sku).join(",");
    setFetching(true);
    try {
      const res = await fetch("/api/sku/print-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skus: tray.map((t) => t.sku) }),
      });
      const d = await res.json();
      if (!res.ok) { flash(d.error ?? "Price fetch failed"); return; }
      // A tray edited mid-fetch invalidates this response — otherwise a SKU
      // added during the fetch would silently print with dashes.
      if (fetchId !== fetchIdRef.current || snapshot !== trayKey) return;
      setPriceData(new Map((d.items as PrintDatum[]).map((i) => [i.sku, i])));
    } finally {
      setFetching(false);
    }
  }

  const missing = useMemo(
    () => (priceData ? tray.filter((t) => priceData.get(t.sku)?.found === false).map((t) => t.sku) : []),
    [priceData, tray],
  );
  const readyToPrint = tray.length > 0 && (!withPrice || priceData !== null);

  async function output(kind: "print" | "download") {
    setBuilding(true);
    try {
      const doc = await buildRollPdf(tray, cal, withPrice, priceData ?? new Map());
      if (kind === "download") doc.save(pdfFileName(withPrice));
      else if (!printPdf(doc)) flash("Print blocked — use Download PDF");
    } finally {
      setBuilding(false);
    }
  }

  const label = (t: string) => (
    <span className="font-body uppercase block" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige, marginBottom: 4 }}>{t}</span>
  );
  const btn = (primary = false) => ({
    fontSize: 9.5, letterSpacing: "0.14em", padding: "8px 13px",
    background: primary ? palette.black : "transparent",
    color: primary ? palette.ivory : palette.black,
    border: primary ? "none" : `1px solid ${palette.black}`,
  });

  return (
    <div className="mt-5">
      {/* Add from registry */}
      <div className="p-3" style={{ background: palette.ivoryDeep }}>
        {label("Add from registry")}
        <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 10px", background: palette.ivory }}>
          <Search size={14} color={palette.mutedGreige} />
          <input value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} placeholder="Search SKU or description" className="font-body flex-1 bg-transparent outline-none" style={{ fontSize: 12.5 }} />
          {pickQuery && <button type="button" onClick={() => setPickQuery("")} aria-label="Clear"><X size={14} color={palette.mutedGreige} /></button>}
          <button type="button" onClick={() => setScanning(true)} className="flex items-center gap-1.5 font-body uppercase flex-shrink-0" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}>
            <ScanLine size={13} strokeWidth={1.7} /> Scan
          </button>
        </div>
        {bases === null && <p className="font-body mt-2" style={{ fontSize: 11, color: palette.mutedGreige }}>Loading registry…</p>}
        {bases !== null && pickResults.length > 0 && (
          <>
            <div className="mt-2 max-h-56 overflow-y-auto" style={{ border: "1px solid rgba(26,26,26,0.1)", background: palette.ivory }}>
              {pickResults.map((v) => (
                <div key={v.sku} className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.05)" }}>
                  <span className="font-mono min-w-0 flex-1 truncate" style={{ fontSize: 11.5, fontWeight: 600 }}>{v.sku}</span>
                  <button type="button" onClick={() => { add(v.sku); flash(`${v.sku} added`); }} className="font-body uppercase flex-shrink-0" style={{ fontSize: 8.5, letterSpacing: "0.1em", padding: "4px 9px", border: `1px solid ${palette.black}` }}>+ Add</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => { pickResults.forEach((v) => add(v.sku)); flash(`${pickResults.length} added`); }} className="mt-2 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep }}>
              Add all {pickResults.length} shown
            </button>
          </>
        )}
        <div className="mt-3">
          {label("Bulk add (one per line or comma-separated)")}
          <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={2} className="font-body w-full bg-transparent outline-none resize-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 11.5, background: palette.ivory }} />
          <button type="button" onClick={addBulk} disabled={!bulk.trim()} className="mt-1 font-body uppercase disabled:opacity-40" style={btn()}>Add all</button>
        </div>
      </div>

      {/* Tray */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          {label(`Print tray · ${totalLabels} label${totalLabels === 1 ? "" : "s"}`)}
          {tray.length > 0 && (
            <button type="button" onClick={() => { if (window.confirm("Clear the whole print tray?")) setTray([]); }} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.1em", color: palette.crimsonText }}>
              <Trash2 size={11} /> Clear all
            </button>
          )}
        </div>
        {tray.length === 0 ? (
          <p className="font-body mt-1" style={{ fontSize: 11.5, color: palette.mutedGreige }}>Nothing queued — add SKUs above, from Generate results, or by scanning tags.</p>
        ) : (
          <div className="mt-1 flex flex-col">
            {tray.map((t) => (
              <div key={t.sku} className="flex items-center gap-2 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <span className="font-mono min-w-0 flex-1 truncate" style={{ fontSize: 12, fontWeight: 600 }}>{t.sku}</span>
                {priceData && priceData.get(t.sku)?.found === false && (
                  <span className="font-body flex-shrink-0" style={{ fontSize: 8.5, color: palette.crimsonText }}>not in master</span>
                )}
                <div className="flex items-center flex-shrink-0" style={{ border: "1px solid rgba(26,26,26,0.2)" }}>
                  <button type="button" onClick={() => setTray((x) => x.map((i) => (i.sku === t.sku ? { ...i, copies: Math.max(1, i.copies - 1) } : i)))} className="px-2 py-1" aria-label="Fewer"><Minus size={12} /></button>
                  <span className="font-body" style={{ minWidth: 26, textAlign: "center", fontSize: 12, fontWeight: 600 }}>{t.copies}</span>
                  <button type="button" onClick={() => setTray((x) => x.map((i) => (i.sku === t.sku ? { ...i, copies: i.copies + 1 } : i)))} className="px-2 py-1" aria-label="More"><Plus size={12} /></button>
                </div>
                <button type="button" onClick={() => setTray((x) => x.filter((i) => i.sku !== t.sku))} aria-label={`Remove ${t.sku}`} className="p-1 flex-shrink-0"><X size={14} color={palette.mutedGreige} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mode + price fetch */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => setWithPrice(false)} className="font-body uppercase" style={{ ...btn(!withPrice) }}>Plain</button>
        <button type="button" onClick={() => setWithPrice(true)} className="font-body uppercase" style={{ ...btn(withPrice) }}>With price</button>
        {withPrice && (
          <button type="button" onClick={fetchPrices} disabled={fetching || tray.length === 0} className="flex items-center gap-1.5 font-body uppercase disabled:opacity-50" style={btn()}>
            <RefreshCw size={12} className={fetching ? "animate-spin" : undefined} /> {fetching ? "Fetching…" : priceData ? "Refetch price data" : "Fetch price data"}
          </button>
        )}
      </div>
      {withPrice && !priceData && tray.length > 0 && (
        <p className="font-body mt-2" style={{ fontSize: 11, color: palette.goldDeep }}>Fetch price data before printing — labels carry the coded vendor line and MRP.</p>
      )}
      {withPrice && missing.length > 0 && (
        <p className="font-body mt-2" style={{ fontSize: 11, color: palette.crimsonText }}>
          Not in the product master (will print with dashes): {missing.join(", ")}
        </p>
      )}

      {/* Output */}
      <div className="mt-3 flex gap-2 flex-wrap">
        <button type="button" onClick={() => output("print")} disabled={!readyToPrint || building} className="flex items-center gap-2 font-body uppercase disabled:opacity-50" style={btn(true)}>
          <Printer size={13} /> {building ? "Building…" : "Print"}
        </button>
        <button type="button" onClick={() => output("download")} disabled={!readyToPrint || building} className="flex items-center gap-2 font-body uppercase disabled:opacity-50" style={btn()}>
          <Download size={13} /> Download PDF
        </button>
      </div>

      {/* Calibration */}
      <div className="mt-5">
        <button type="button" onClick={() => setShowCal((v) => !v)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige, borderBottom: "1px dotted rgba(26,26,26,0.3)" }}>
          Label calibration {showCal ? "▴" : "▾"}
        </button>
        {showCal && (
          <div className="mt-2 p-3" style={{ background: palette.ivoryDeep }}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {([["rollW", "Width mm"], ["rollH", "Height mm"], ["across", "Across"], ["gapX", "Gap mm"]] as const).map(([key, name]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.14em", color: palette.mutedGreige }}>{name}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={cal[key]}
                    onChange={(e) => setCal((c) => ({ ...c, [key]: Number(e.target.value) || 0 }))}
                    className="font-body bg-transparent outline-none"
                    style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 12, background: palette.ivory }}
                  />
                </label>
              ))}
            </div>
            <button type="button" onClick={() => setCal(DEFAULT_CAL)} className="mt-2 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.goldDeep }}>Reset to defaults (38 × 25, 1 across, 3 gap)</button>
            <p className="font-body mt-2" style={{ fontSize: 10, color: palette.mutedGreige, lineHeight: 1.5 }}>
              Define the driver stock as the same size and always print at 100% / Actual size.
            </p>
          </div>
        )}
      </div>

      {scanning && <QrScanner title="Scan tags into the tray" onScan={handleScan} onClose={() => setScanning(false)} holdFeedback />}
    </div>
  );
}

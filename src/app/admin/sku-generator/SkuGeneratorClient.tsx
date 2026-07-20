"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Search, X, ScanLine, Copy, QrCode, Printer, Download, Share2, Plus } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { CATEGORIES, COLOR_GROUPS, SIZES, type CategoryCode } from "@/lib/sku/vocab";
import { qrPngDataUrl, shareQr, downloadDataUrl, buildRollPdf, printPdf, DEFAULT_CAL, TRAY_KEY, type TrayItem } from "./labels";
import { PrintTab } from "./PrintTab";
import { palette } from "@/lib/palette";

interface HistoryRow {
  variant_sku: string; base_sku: string; category: string; sub_category: string;
  color: string; size: string; description: string; created_by: string; created_at: string;
}
export interface BaseEntry {
  base: string; cat: string; sub: string; catName: string; subName: string;
  desc: string; variantCount: number; variants: { sku: string; size: string; color: string }[]; latestTs: string;
}

const shortname = (email: string) => email.split("@")[0];
const istTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

// Color ranking from the reference: code exact → code prefix → name prefix →
// code contains → name contains.
function rankColors(q: string): [string, string][] {
  const all = COLOR_GROUPS.flatMap((g) => g.items.map(([c, n]) => [c, n] as [string, string]));
  const s = q.trim().toUpperCase();
  if (!s) return all;
  const score = ([code, name]: [string, string]) => {
    const N = name.toUpperCase();
    if (code === s) return 0;
    if (code.startsWith(s)) return 1;
    if (N.startsWith(s)) return 2;
    if (code.includes(s)) return 3;
    if (N.includes(s)) return 4;
    return 9;
  };
  return all.filter((c) => score(c) < 9).sort((a, b) => score(a) - score(b));
}

export function SkuGeneratorClient({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<"generate" | "print">("generate");

  // ---- shared state ----
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [totalSkus, setTotalSkus] = useState(0);
  const [bases, setBases] = useState<BaseEntry[] | null>(null);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const flash = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); }, []);

  // ---- generate form ----
  const [mode, setMode] = useState<"new" | "variant">("new");
  const [cat, setCat] = useState<CategoryCode | "">("");
  const [sub, setSub] = useState("");
  const [peekNum, setPeekNum] = useState<number | null>(null);
  const [baseQuery, setBaseQuery] = useState("");
  const [selectedBase, setSelectedBase] = useState<BaseEntry | null>(null);
  const [colorQuery, setColorQuery] = useState("");
  const [color, setColor] = useState("");
  const [colorOpen, setColorOpen] = useState(false);
  const [colorIdx, setColorIdx] = useState(0);
  const [size, setSize] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; duplicate: boolean; dupSku?: string } | null>(null);
  const [result, setResult] = useState<{ baseSku: string; variantSku: string } | null>(null);
  const [scanTarget, setScanTarget] = useState<"base" | "lookup" | null>(null);
  const [lookup, setLookup] = useState("");
  const [lookupSku, setLookupSku] = useState<string | null>(null);
  const [qrModal, setQrModal] = useState<string | null>(null);

  // ---- bootstrap ----
  useEffect(() => {
    fetch("/api/sku/state").then((r) => r.json()).then((d) => {
      if (d.counters) { setCounters(d.counters); setHistory(d.history); setTotalSkus(d.totalSkus); }
    }).catch(() => {});
    try {
      const raw = localStorage.getItem(TRAY_KEY);
      if (raw) setTray(JSON.parse(raw));
    } catch { /* corrupted tray — start fresh */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(TRAY_KEY, JSON.stringify(tray)); } catch { /* full */ }
  }, [tray]);
  const loadBases = useCallback(() => {
    if (bases) return;
    fetch("/api/sku/bases").then((r) => r.json()).then((d) => setBases(d.bases ?? [])).catch(() => setBases([]));
  }, [bases]);
  useEffect(() => { if (mode === "variant" || tab === "print") loadBases(); }, [mode, tab, loadBases]);

  // Next-# preview: local estimate instantly, server peek reconciles (400ms debounce).
  useEffect(() => {
    if (mode !== "new" || !cat || !sub) { setPeekNum(null); return; }
    setPeekNum((counters[`${cat}-${sub}`] ?? 0) + 1);
    const t = setTimeout(() => {
      fetch(`/api/sku/peek?cat=${cat}&sub=${sub}`).then((r) => r.json()).then((d) => {
        if (typeof d.next === "number") setPeekNum(d.next);
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [mode, cat, sub, counters]);

  const addToTray = useCallback((sku: string) => {
    setTray((t) => {
      const key = sku.trim().toUpperCase();
      const ex = t.find((i) => i.sku === key);
      return ex ? t.map((i) => (i.sku === key ? { ...i, copies: i.copies + 1 } : i)) : [...t, { sku: key, copies: 1 }];
    });
    flash(`${sku} added to print sheet`);
  }, [flash]);

  const copyText = useCallback(async (text: string) => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* old WebView */ }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    }
    flash(ok ? "Copied" : "Copy failed — long-press to copy manually");
  }, [flash]);

  // ---- base picker ----
  const baseResults = useMemo(() => {
    if (!bases) return [];
    const q = baseQuery.trim().toUpperCase();
    if (!q) return bases.slice(0, 8);
    return bases
      .filter((b) => b.base.includes(q) || b.desc.toUpperCase().includes(q) || `${b.catName} ${b.subName}`.toUpperCase().includes(q))
      .slice(0, 8);
  }, [bases, baseQuery]);

  const variantExists = useMemo(() => {
    if (!selectedBase || !color || !size) return false;
    return selectedBase.variants.some((v) => v.size === size && v.color === color);
  }, [selectedBase, color, size]);

  function resolveBaseFromScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    const base = sku.match(/^(DD-[A-Z]{2,4}-[A-Z0-9]{2,4}-\d{3})/)?.[1];
    if (!base) return { ok: false, message: `${sku || "Empty scan"} — not a Drevi SKU` };
    const entry = bases?.find((b) => b.base === base);
    if (!entry) return { ok: false, message: `${base} — not in the registry` };
    setSelectedBase(entry);
    setBaseQuery(base);
    setScanTarget(null);
    return { ok: true, message: `${base} · ${entry.variantCount} variant${entry.variantCount === 1 ? "" : "s"}` };
  }

  // ---- generate ----
  async function generate() {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const res = await fetch("/api/sku/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          cat: cat || undefined,
          sub: sub || undefined,
          baseSku: selectedBase?.base,
          color,
          size,
          description,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        const dupSku = mode === "variant" && selectedBase ? `${selectedBase.base}-${size}-${color}` : undefined;
        setError({ message: d.error ?? "Failed", duplicate: !!d.duplicate, dupSku });
        return;
      }
      setResult({ baseSku: d.baseSku, variantSku: d.variantSku });
      // refresh state + bases
      fetch("/api/sku/state").then((r) => r.json()).then((s) => {
        if (s.counters) { setCounters(s.counters); setHistory(s.history); setTotalSkus(s.totalSkus); }
      }).catch(() => {});
      setBases(null);
    } finally {
      setBusy(false);
    }
  }

  const canGenerate = !busy && color && size && (mode === "new" ? cat && sub : !!selectedBase) && !(mode === "variant" && variantExists);

  // ---- styles ----
  const label = (t: string) => (
    <span className="font-body uppercase block" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige, marginBottom: 4 }}>{t}</span>
  );
  const chip = (active: boolean) => ({
    fontSize: 9.5, letterSpacing: "0.12em", padding: "7px 13px",
    color: active ? palette.ivory : palette.softBlack,
    background: active ? palette.black : "transparent",
    border: active ? "none" : "1px solid rgba(26,26,26,0.2)",
  });
  const selectStyle = { border: "1px solid rgba(26,26,26,0.2)", padding: "9px 10px", fontSize: 13, background: palette.ivory, width: "100%" } as const;

  const colorList = useMemo(() => rankColors(colorQuery), [colorQuery]);
  const colorName = useMemo(
    () => COLOR_GROUPS.flatMap((g) => g.items.map(([c, n]) => [c, n] as [string, string])).find(([c]) => c === color)?.[1],
    [color],
  );

  const qrActions = (sku: string, extra?: boolean) => (
    <div className="flex gap-2 flex-wrap mt-3">
      <button type="button" onClick={async () => downloadDataUrl(await qrPngDataUrl(sku), `${sku}.png`)} className="flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, padding: "7px 11px" }}><Download size={12} /> Download</button>
      <button type="button" onClick={async () => flash((await shareQr(sku)) === "shared" ? "Shared" : "Downloaded (share unavailable)")} className="flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, padding: "7px 11px" }}><Share2 size={12} /> Share</button>
      <button type="button" onClick={async () => { const doc = await buildRollPdf([{ sku, copies: 1 }], DEFAULT_CAL, false, new Map()); if (!printPdf(doc)) flash("Print blocked — use Download PDF"); }} className="flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, padding: "7px 11px" }}><Printer size={12} /> Print</button>
      {extra !== false && (
        <button type="button" onClick={() => addToTray(sku)} className="flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", background: palette.black, color: palette.ivory, padding: "7px 11px" }}><Plus size={12} /> Add to print sheet</button>
      )}
    </div>
  );

  return (
    <div className="px-4 md:px-6 py-5 max-w-3xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>SKU Generator</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, color: palette.mutedGreige }}>
        {totalSkus} SKUs in the registry · every mint is recorded and mirrored to the sheet.
      </p>

      {/* Tabs */}
      <div className="flex gap-1.5 mt-4">
        <button type="button" onClick={() => setTab("generate")} className="font-body uppercase" style={chip(tab === "generate")}>Generate</button>
        <button type="button" onClick={() => setTab("print")} className="font-body uppercase" style={chip(tab === "print")}>
          Print{tray.length > 0 ? ` · ${tray.reduce((n, t) => n + t.copies, 0)}` : ""}
        </button>
      </div>

      {tab === "print" ? (
        <PrintTab tray={tray} setTray={setTray} bases={bases} flash={flash} />
      ) : (
        <>
          {/* Mode toggle */}
          <div className="flex gap-1.5 mt-5">
            <button type="button" onClick={() => { setMode("new"); setError(null); setResult(null); }} className="font-body uppercase" style={chip(mode === "new")}>New Design</button>
            <button type="button" onClick={() => { setMode("variant"); setError(null); setResult(null); }} className="font-body uppercase" style={chip(mode === "variant")}>Variant of Existing</button>
          </div>
          <p className="font-body mt-2" style={{ fontSize: 11, color: palette.mutedGreige, lineHeight: 1.5 }}>
            {mode === "new"
              ? "A new design gets the next number in its category — one number per design, however many colours and sizes follow."
              : "A variant reuses an existing design's number with a new size + colour. Same garment, different colour/size → variant, never a new design."}
          </p>

          {/* New Design: cat/sub */}
          {mode === "new" && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              <div>
                {label("Category")}
                <select value={cat} onChange={(e) => { setCat(e.target.value as CategoryCode); setSub(""); }} className="font-body" style={selectStyle}>
                  <option value="">Select…</option>
                  {Object.entries(CATEGORIES).map(([code, c]) => <option key={code} value={code}>{code} — {c.name}</option>)}
                </select>
              </div>
              <div>
                {label("Sub-Category")}
                <select value={sub} onChange={(e) => setSub(e.target.value)} disabled={!cat} className="font-body disabled:opacity-50" style={selectStyle}>
                  <option value="">Select…</option>
                  {cat && Object.entries(CATEGORIES[cat].subs).map(([code, name]) => <option key={code} value={code}>{code} — {name}</option>)}
                </select>
              </div>
              <div>
                {label("Next #")}
                <div className="font-mono" style={{ border: "1px dashed rgba(26,26,26,0.25)", padding: "9px 10px", fontSize: 13, color: peekNum ? palette.goldDeep : palette.mutedGreige, fontWeight: 700 }}>
                  {peekNum != null && cat && sub ? `DD-${cat}-${sub}-${String(peekNum).padStart(3, "0")}` : "—"}
                </div>
              </div>
            </div>
          )}

          {/* Variant: base picker */}
          {mode === "variant" && (
            <div className="mt-4">
              {label("Base design")}
              <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px" }}>
                <Search size={14} color={palette.mutedGreige} />
                <input
                  value={baseQuery}
                  onChange={(e) => { setBaseQuery(e.target.value); setSelectedBase(null); }}
                  placeholder="Search base SKU or description"
                  className="font-body flex-1 bg-transparent outline-none"
                  style={{ fontSize: 13 }}
                />
                {baseQuery && <button type="button" onClick={() => { setBaseQuery(""); setSelectedBase(null); }} aria-label="Clear"><X size={14} color={palette.mutedGreige} /></button>}
                <button type="button" onClick={() => { loadBases(); setScanTarget("base"); }} className="flex items-center gap-1.5 font-body uppercase flex-shrink-0" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}>
                  <ScanLine size={13} strokeWidth={1.7} /> Scan
                </button>
              </div>
              {!selectedBase && baseQuery.trim() !== "" && (
                <div style={{ border: "1px solid rgba(26,26,26,0.12)", borderTop: "none" }}>
                  {(bases === null) && <div className="font-body p-3" style={{ fontSize: 11.5, color: palette.mutedGreige }}>Loading registry…</div>}
                  {bases !== null && baseResults.length === 0 && <div className="font-body p-3" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No designs match.</div>}
                  {baseResults.map((b) => (
                    <button key={b.base} type="button" onClick={() => { setSelectedBase(b); setBaseQuery(b.base); }} className="w-full text-left px-3 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", background: palette.ivory }}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 700 }}>{b.base}</span>
                        <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>{b.catName} · {b.subName}</span>
                      </div>
                      {b.desc && <div className="font-body truncate" style={{ fontSize: 10.5, color: palette.softBlack }}>{b.desc}</div>}
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {b.variants.slice(0, 4).map((v) => (
                          <span key={v.sku} className="font-mono" style={{ fontSize: 8.5, padding: "2px 6px", background: palette.ivoryDeep, color: palette.softBlack }}>{v.size}-{v.color}</span>
                        ))}
                        {b.variantCount > 4 && <span className="font-body" style={{ fontSize: 8.5, color: palette.mutedGreige }}>+{b.variantCount - 4}</span>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {selectedBase && (
                <div className="mt-2 p-3" style={{ background: palette.ivoryDeep }}>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: palette.goldDeep }}>{selectedBase.base}</span>
                    <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>{selectedBase.catName} · {selectedBase.subName} · {selectedBase.variantCount} variant{selectedBase.variantCount === 1 ? "" : "s"}</span>
                  </div>
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {selectedBase.variants.map((v) => (
                      <span key={v.sku} className="font-mono" style={{ fontSize: 9, padding: "2px 7px", background: palette.ivory, color: palette.softBlack, border: "1px solid rgba(26,26,26,0.1)" }}>{v.size}-{v.color}</span>
                    ))}
                  </div>
                  {variantExists && (
                    <p className="font-body mt-2" style={{ fontSize: 11, color: palette.crimsonText, fontWeight: 600 }}>
                      {size}-{color} already exists for this design — pick a different size/colour, or log a Goods Receipt for restock.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Color + Size */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div className="relative">
              {label("Colour")}
              <input
                value={color ? `${color} — ${colorName}` : colorQuery}
                onChange={(e) => { setColor(""); setColorQuery(e.target.value); setColorOpen(true); setColorIdx(0); }}
                onFocus={() => { setColorOpen(true); if (color) { setColor(""); setColorQuery(""); } }}
                onKeyDown={(e) => {
                  if (!colorOpen) return;
                  if (e.key === "ArrowDown") { e.preventDefault(); setColorIdx((i) => Math.min(i + 1, colorList.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setColorIdx((i) => Math.max(i - 1, 0)); }
                  else if (e.key === "Enter") { e.preventDefault(); const c = colorList[colorIdx]; if (c) { setColor(c[0]); setColorOpen(false); } }
                  else if (e.key === "Escape") setColorOpen(false);
                }}
                placeholder="Type a colour or code"
                className="font-body w-full bg-transparent outline-none"
                style={selectStyle}
              />
              {colorOpen && !color && (
                <div className="absolute z-20 w-full max-h-64 overflow-y-auto" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.15)", boxShadow: "0 8px 24px rgba(26,26,26,0.12)" }}>
                  {colorQuery.trim() === "" ? (
                    COLOR_GROUPS.map((g) => (
                      <div key={g.name}>
                        <div className="font-body uppercase px-3 py-1.5" style={{ fontSize: 8, letterSpacing: "0.16em", color: palette.goldDeep, background: palette.ivoryDeep }}>{g.name}</div>
                        {g.items.map(([code, name]) => (
                          <button key={code} type="button" onMouseDown={(e) => { e.preventDefault(); setColor(code); setColorOpen(false); }} className="w-full text-left px-3 py-2 font-body" style={{ fontSize: 12.5, borderBottom: "1px solid rgba(26,26,26,0.04)" }}>
                            <span className="font-mono" style={{ fontWeight: 700 }}>{code}</span> — {name}
                          </button>
                        ))}
                      </div>
                    ))
                  ) : (
                    colorList.map(([code, name], i) => (
                      <button key={code} type="button" onMouseDown={(e) => { e.preventDefault(); setColor(code); setColorOpen(false); }} className="w-full text-left px-3 py-2 font-body" style={{ fontSize: 12.5, background: i === colorIdx ? palette.ivoryDeep : undefined }}>
                        <span className="font-mono" style={{ fontWeight: 700 }}>{code}</span> — {name}
                      </button>
                    ))
                  )}
                  {colorQuery.trim() !== "" && colorList.length === 0 && <div className="font-body p-3" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No colours match.</div>}
                </div>
              )}
            </div>
            <div>
              {label("Size")}
              <select value={size} onChange={(e) => setSize(e.target.value)} className="font-body" style={selectStyle}>
                <option value="">Select…</option>
                {Object.entries(SIZES).map(([code, name]) => <option key={code} value={code}>{code === name ? code : `${code} — ${name}`}</option>)}
              </select>
            </div>
          </div>

          <div className="mt-3">
            {label("Description (optional)")}
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="font-body w-full bg-transparent outline-none resize-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 12.5 }} />
          </div>

          {error && (
            <div className="mt-4 p-3" style={{ background: palette.crimsonSoft, border: `1px solid ${palette.crimsonBorder}` }}>
              <p className="font-body" style={{ fontSize: 12, color: palette.crimsonText, lineHeight: 1.5 }}>{error.message}</p>
              {error.duplicate && isAdmin && (
                <Link href={`/admin/receipts/new?sku=${encodeURIComponent(error.dupSku ?? "")}`} className="inline-block mt-2 font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 13px" }}>
                  Log Goods Receipt
                </Link>
              )}
            </div>
          )}

          <button type="button" onClick={generate} disabled={!canGenerate} className="mt-4 w-full font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "14px 0" }}>
            {busy ? "Generating…" : "Generate SKU"}
          </button>

          {/* Result card */}
          {result && (
            <div className="mt-5 p-4" style={{ background: palette.black }}>
              <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.18em", color: palette.champagne }}>Base SKU · design level</div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="font-mono" style={{ fontSize: 17, fontWeight: 700, color: palette.gold }}>{result.baseSku}</span>
                <button type="button" onClick={() => copyText(result.baseSku)} aria-label="Copy base" className="p-1"><Copy size={13} color={palette.champagne} /></button>
              </div>
              <div className="font-body uppercase mt-3" style={{ fontSize: 8.5, letterSpacing: "0.18em", color: palette.champagne }}>Variant SKU · for Shopify</div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="font-mono" style={{ fontSize: 17, fontWeight: 700, color: palette.ivory }}>{result.variantSku}</span>
                <button type="button" onClick={() => copyText(result.variantSku)} aria-label="Copy variant" className="p-1"><Copy size={13} color={palette.champagne} /></button>
              </div>
              <div style={{ background: palette.ivory, padding: 12, marginTop: 12 }}>
                <QrInline sku={result.variantSku} />
                {qrActions(result.variantSku)}
              </div>
            </div>
          )}

          {/* Counters */}
          {Object.keys(counters).length > 0 && (
            <div className="mt-6">
              <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Design counters</div>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {Object.entries(counters).sort().map(([k, n]) => (
                  <span key={k} className="font-mono" style={{ fontSize: 10.5, padding: "5px 9px", background: palette.ivoryDeep, color: palette.softBlack }}>{k}: {n}</span>
                ))}
              </div>
            </div>
          )}

          {/* Recently generated */}
          {history.length > 0 && (
            <div className="mt-6">
              <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Recently generated</div>
              <div className="mt-2 flex flex-col">
                {history.slice(0, 20).map((h) => (
                  <div key={h.variant_sku} className="flex items-center gap-2 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                    <div className="min-w-0 flex-1">
                      <span className="font-mono block truncate" style={{ fontSize: 12, fontWeight: 600, color: palette.black }}>{h.variant_sku}</span>
                      <span className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>{shortname(h.created_by)} · {istTime(h.created_at)}</span>
                    </div>
                    <button type="button" onClick={() => setQrModal(h.variant_sku)} aria-label="QR" className="p-1.5"><QrCode size={15} color={palette.softBlack} /></button>
                    <button type="button" onClick={() => addToTray(h.variant_sku)} aria-label="Add to print sheet" className="p-1.5"><Plus size={15} color={palette.goldDeep} /></button>
                    <button type="button" onClick={() => copyText(h.variant_sku)} aria-label="Copy" className="p-1.5"><Copy size={14} color={palette.mutedGreige} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* QR Lookup */}
          <div className="mt-6 p-3" style={{ background: palette.ivoryDeep }}>
            <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>QR lookup</div>
            <div className="flex items-center gap-2 mt-2" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 10px", background: palette.ivory }}>
              <input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Any SKU or text" className="font-body flex-1 bg-transparent outline-none" style={{ fontSize: 12.5 }} />
              <button type="button" onClick={() => setScanTarget("lookup")} className="flex items-center gap-1.5 font-body uppercase flex-shrink-0" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}>
                <ScanLine size={13} strokeWidth={1.7} /> Scan
              </button>
              <button type="button" onClick={() => lookup.trim() && setLookupSku(lookup.trim().toUpperCase())} className="font-body uppercase flex-shrink-0" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", border: `1px solid ${palette.black}` }}>
                Show QR
              </button>
            </div>
            {lookupSku && (
              <div className="mt-3" style={{ background: palette.ivory, padding: 12 }}>
                <span className="font-mono" style={{ fontSize: 13, fontWeight: 700 }}>{lookupSku}</span>
                <QrInline sku={lookupSku} />
                {qrActions(lookupSku)}
              </div>
            )}
          </div>
        </>
      )}

      {/* Scanner overlay */}
      {scanTarget && (
        <QrScanner
          title={scanTarget === "base" ? "Scan a tag to pick its design" : "Scan any tag"}
          onScan={(text) => {
            if (scanTarget === "base") return resolveBaseFromScan(text);
            const sku = text.trim().toUpperCase();
            setLookup(sku); setLookupSku(sku); setScanTarget(null);
            return { ok: true, message: sku };
          }}
          onClose={() => setScanTarget(null)}
        />
      )}

      {/* QR modal for history rows */}
      {qrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(26,26,26,0.55)" }} onClick={() => setQrModal(null)}>
          <div style={{ background: palette.ivory, padding: 18, maxWidth: 340, width: "100%" }} onClick={(e) => e.stopPropagation()}>
            <span className="font-mono" style={{ fontSize: 13, fontWeight: 700 }}>{qrModal}</span>
            <QrInline sku={qrModal} />
            {qrActions(qrModal)}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase z-[60]" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px" }}>{toast}</div>
      )}
    </div>
  );
}

// Deterministic on-demand QR — never persisted (spec §6.1).
function QrInline({ sku }: { sku: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const reqRef = useRef(0);
  useEffect(() => {
    const id = ++reqRef.current;
    qrPngDataUrl(sku, 440).then((u) => { if (id === reqRef.current) setUrl(u); });
  }, [sku]);
  return (
    <div className="mt-2 flex justify-center" style={{ background: "#FFFFFF", padding: 10 }}>
      {url
        // eslint-disable-next-line @next/next/no-img-element -- data-URL QR, no CDN involved
        ? <img src={url} alt={`QR for ${sku}`} style={{ width: 180, height: 180, imageRendering: "pixelated" }} />
        : <div style={{ width: 180, height: 180 }} />}
    </div>
  );
}

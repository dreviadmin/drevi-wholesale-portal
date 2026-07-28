"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine, Check, Trash2, AlertTriangle } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { palette } from "@/lib/palette";
import { lookupSku, commitCount, type ScannedSku } from "./actions";

// Retrofit R8 §10.2b — built for walking the rack:
//   scan a tag → SKU + system quantity appear → type the counted quantity → next
// Scanning the same tag again RETURNS TO THAT LINE rather than duplicating it.
// A running list shows variance; Commit writes one reset per counted SKU.

const DRAFT_KEY = "drevi:stocktake:draft";

interface Line extends ScannedSku {
  countedQty: number | null;
}

export function StockTake() {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const [note, setNote] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const qtyRef = useRef<HTMLInputElement | null>(null);

  // A stock take is a long walk around a rack — never lose it to a reload.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        setLines(d.lines ?? []);
        setNote(d.note ?? "");
      }
    } catch { /* corrupted draft — start clean */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ lines, note })); } catch { /* quota — the screen still works */ }
  }, [lines, note]);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2600); }

  function add(item: ScannedSku): "existing" | "new" {
    let outcome: "existing" | "new" = "new";
    setLines((prev) => {
      const at = prev.findIndex((l) => l.sku === item.sku);
      if (at >= 0) { outcome = "existing"; return prev; }
      return [{ ...item, countedQty: null }, ...prev];
    });
    setActive(item.sku);
    setTimeout(() => qtyRef.current?.focus(), 60);
    return outcome;
  }

  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    // The scanner is synchronous; resolve in the background and report.
    startTransition(async () => {
      const r = await lookupSku(sku);
      if (!r.ok || !r.item) { flash(r.error ?? "Not found"); return; }
      const outcome = add(r.item);
      flash(outcome === "existing" ? `${sku} — already on the list` : `${sku} · system ${r.item.systemQty}`);
    });
    return { ok: true, message: sku };
  }

  function addManual() {
    const sku = manual.trim().toUpperCase();
    if (!sku) return;
    startTransition(async () => {
      const r = await lookupSku(sku);
      if (!r.ok || !r.item) { flash(r.error ?? "Not found"); return; }
      add(r.item);
      setManual("");
    });
  }

  function setQty(sku: string, v: string) {
    const n = v === "" ? null : Math.max(0, parseInt(v.replace(/[^\d]/g, ""), 10) || 0);
    setLines((prev) => prev.map((l) => (l.sku === sku ? { ...l, countedQty: n } : l)));
  }

  const counted = lines.filter((l) => l.countedQty !== null);
  const variance = counted.reduce((s, l) => s + Math.abs((l.countedQty ?? 0) - l.systemQty), 0);

  function commit() {
    if (counted.length === 0) { flash("Nothing counted yet"); return; }
    startTransition(async () => {
      const res = await commitCount(
        counted.map((l) => ({ sku: l.sku, countedQty: l.countedQty! })),
        note,
      );
      if (res.ok) {
        flash(`${res.committed} SKU(s) set`);
        setLines([]); setNote(""); setActive(null);
        try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
        router.refresh();
      } else {
        flash(res.error ?? "Commit failed");
      }
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Stock take</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, lineHeight: 1.6, color: palette.softBlack }}>
        Scan a tag, type what you counted, move on. Committing writes an absolute count for each
        SKU on the list — it <b>supersedes earlier receipt arithmetic</b> for those SKUs.
        Anything you don&apos;t count is left completely untouched.
      </p>

      <div className="flex flex-wrap gap-2 mt-4">
        <button
          type="button"
          onClick={() => setScanning(true)}
          className="flex items-center gap-2 font-body uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.gold, color: palette.black, padding: "11px 16px", fontWeight: 600 }}
        >
          <ScanLine size={15} strokeWidth={2} /> Scan a tag
        </button>
        <div className="flex">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManual(); } }}
            placeholder="or type a SKU"
            className="font-mono px-3"
            style={{ fontSize: 11.5, border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black, minWidth: 190 }}
          />
          <button type="button" onClick={addManual} disabled={pending} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9.5, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "0 12px" }}>
            Add
          </button>
        </div>
      </div>

      <div className="mt-4">
        <label className="font-body uppercase block" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Session note</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={`Stock take ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
          className="w-full font-body p-2 mt-1"
          style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black }}
        />
      </div>

      {lines.length > 0 && (
        <div className="mt-5" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
          {lines.map((l) => {
            const diff = l.countedQty === null ? null : l.countedQty - l.systemQty;
            return (
              <div
                key={l.sku}
                className="flex items-center gap-3 py-2.5"
                style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", background: active === l.sku ? "rgba(196,163,90,0.10)" : "transparent" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono" style={{ fontSize: 11, color: palette.black }}>{l.sku}</div>
                  <div className="font-body truncate" style={{ fontSize: 10, color: palette.mutedGreige }}>
                    {l.title ?? "—"} · system {l.systemQty}
                  </div>
                </div>
                <input
                  ref={active === l.sku ? qtyRef : undefined}
                  value={l.countedQty ?? ""}
                  onChange={(e) => setQty(l.sku, e.target.value)}
                  onFocus={() => setActive(l.sku)}
                  inputMode="numeric"
                  placeholder="count"
                  className="font-body text-center"
                  style={{ width: 66, fontSize: 13, padding: "7px 4px", border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black }}
                />
                <span className="font-body" style={{ width: 52, textAlign: "right", fontSize: 11, fontWeight: 600, color: diff === null ? palette.mutedGreige : diff === 0 ? "#1F6B45" : "#9C3A31" }}>
                  {diff === null ? "—" : diff > 0 ? `+${diff}` : diff}
                </span>
                <button type="button" onClick={() => setLines((p) => p.filter((x) => x.sku !== l.sku))} aria-label={`Remove ${l.sku}`} style={{ color: palette.mutedGreige }}>
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {counted.length > 0 && (
        <div className="mt-5">
          <div className="flex items-start gap-2 p-3" style={{ background: "#FBF3E2", border: "1px solid rgba(196,163,90,0.4)" }}>
            <AlertTriangle size={14} color="#8a6d1a" style={{ flexShrink: 0, marginTop: 2 }} />
            <div className="font-body" style={{ fontSize: 11, lineHeight: 1.55, color: "#8a6d1a" }}>
              Committing sets <b>{counted.length}</b> SKU{counted.length === 1 ? "" : "s"} to the counted quantity
              {variance > 0 ? ` (total variance ${variance} pcs)` : ""}. Earlier movements stay as history but stop
              counting toward stock. The other {lines.length - counted.length} scanned line
              {lines.length - counted.length === 1 ? "" : "s"} and every SKU you did not scan are untouched.
            </div>
          </div>
          <button
            type="button"
            onClick={commit}
            disabled={pending}
            className="mt-3 flex items-center gap-2 font-body uppercase disabled:opacity-40"
            style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.black, color: palette.ivory, padding: "12px 18px" }}
          >
            <Check size={14} /> Commit {counted.length} count{counted.length === 1 ? "" : "s"}
          </button>
        </div>
      )}

      {lines.length === 0 && (
        <div className="font-body py-10 text-center" style={{ fontSize: 12, color: palette.mutedGreige }}>
          Nothing scanned yet.
        </div>
      )}

      {scanning && (
        <QrScanner
          onScan={handleScan}
          onClose={() => setScanning(false)}
          title="Stock take"
          caption="Scan each tag on the rack. Type the counted quantity on the list behind this."
          holdFeedback
        />
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

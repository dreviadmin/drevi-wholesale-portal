"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Check, ChevronDown } from "lucide-react";
import { palette } from "@/lib/palette";
import { recomputeSku, setStockFromDrift } from "./actions";
import type { Movement } from "@/lib/stock-ledger-core";

// Retrofit R8 §10.3 — every row offers exactly two answers:
//   Recompute cache  (the cache was stale)
//   Set stock        (reality differs — writes a reset)

export interface DriftRow {
  sku: string;
  cached: number;
  ledger: number;
  lastReset: string | null;
  recent: Movement[];
}

const REASON_LABEL: Record<string, string> = {
  reset: "Counted", receipt: "Received", order: "Ordered",
  manual: "Manual edit", correction: "Correction", shopify_sync: "Shopify",
};

function when(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });
}

export function DriftReport({ checked, rows }: { checked: number; rows: DriftRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [count, setCount] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2600); }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    startTransition(async () => {
      const r = await fn();
      flash(r.ok ? ok : r.error ?? "Failed");
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-3xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Stock check</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, lineHeight: 1.6, color: palette.softBlack }}>
        {rows.length === 0
          ? `All ${checked} SKUs agree with the movement ledger.`
          : `${rows.length} of ${checked} SKUs disagree with the movement ledger.`}
      </p>
      <p className="font-body mt-2" style={{ fontSize: 11, lineHeight: 1.6, color: palette.mutedGreige }}>
        Anything sold through Shopify POS is still invisible to this app (ANSH-18), so these numbers
        can read <b>high</b>. Correct them with a count, not a guess.
      </p>

      {rows.map((r) => (
        <div key={r.sku} className="mt-3 p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="font-mono" style={{ fontSize: 12, color: palette.black }}>{r.sku}</div>
              <div className="font-body mt-0.5" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                cache <b style={{ color: palette.black }}>{r.cached}</b> · ledger <b style={{ color: palette.black }}>{r.ledger}</b>
                {r.lastReset ? ` · last counted ${when(r.lastReset)}` : " · never counted"}
              </div>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => recomputeSku(r.sku), `${r.sku} recomputed`)}
              className="flex items-center gap-1 font-body uppercase disabled:opacity-40"
              style={{ fontSize: 8.5, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}
              title="The ledger is right and the cached number was stale"
            >
              <RefreshCw size={11} /> Recompute cache
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2 mt-3">
            <div>
              <label className="font-body uppercase block" style={{ fontSize: 8, letterSpacing: "0.14em", color: palette.mutedGreige }}>Counted</label>
              <input
                value={count[r.sku] ?? ""}
                onChange={(e) => setCount((s) => ({ ...s, [r.sku]: e.target.value.replace(/[^\d]/g, "") }))}
                inputMode="numeric"
                className="font-body text-center mt-0.5"
                style={{ width: 70, fontSize: 13, padding: "7px 4px", border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black }}
              />
            </div>
            <input
              value={note[r.sku] ?? ""}
              onChange={(e) => setNote((s) => ({ ...s, [r.sku]: e.target.value }))}
              placeholder="Why — required"
              className="flex-1 font-body p-2"
              style={{ minWidth: 180, fontSize: 11.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black }}
            />
            <button
              type="button"
              disabled={pending || !(count[r.sku] ?? "").length || !(note[r.sku] ?? "").trim()}
              onClick={() => run(() => setStockFromDrift(r.sku, parseInt(count[r.sku], 10), note[r.sku]), `${r.sku} set to ${count[r.sku]}`)}
              className="flex items-center gap-1 font-body uppercase disabled:opacity-40"
              style={{ fontSize: 8.5, letterSpacing: "0.12em", background: palette.black, color: palette.ivory, padding: "8px 11px" }}
              title="Reality differs — this writes a counted quantity that supersedes earlier arithmetic"
            >
              <Check size={11} /> Set stock
            </button>
          </div>

          {r.recent.length > 0 && (
            <div className="mt-2">
              <button type="button" onClick={() => setOpen((s) => ({ ...s, [r.sku]: !s[r.sku] }))} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige }}>
                <ChevronDown size={11} style={{ transform: open[r.sku] ? "rotate(180deg)" : "none" }} />
                Last {r.recent.length} movement{r.recent.length === 1 ? "" : "s"}
              </button>
              {open[r.sku] && (
                <div className="mt-1.5">
                  {r.recent.map((m) => (
                    <div key={m.id} className="flex items-baseline gap-2 py-1 font-body" style={{ fontSize: 10.5, color: palette.softBlack, borderBottom: "1px solid rgba(26,26,26,0.05)" }}>
                      <span style={{ width: 62, color: palette.mutedGreige }}>{when(m.created_at)}</span>
                      <span style={{ width: 84 }}>{REASON_LABEL[m.reason] ?? m.reason}</span>
                      <span style={{ width: 44, fontWeight: 600 }}>
                        {m.reason === "reset" ? `= ${m.snapshot_qty}` : m.delta > 0 ? `+${m.delta}` : m.delta}
                      </span>
                      <span className="truncate" style={{ color: palette.mutedGreige }}>{m.note ?? ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

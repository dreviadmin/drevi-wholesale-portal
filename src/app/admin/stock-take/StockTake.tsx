"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine, Check, Trash2, AlertTriangle, ListChecks, Search, X, ChevronDown, ChevronRight } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { DraftNotice } from "@/components/DraftNotice";
import { useDraft, isDraftOlderThan, DRAFT_NOTICE_AFTER_MS } from "@/lib/useDraft";
import { baseSkuOf } from "@/lib/variants";
import { palette } from "@/lib/palette";
import { lookupSku, commitCount, type ScannedSku, type CountableProduct } from "./actions";

// Retrofit R8 §10.2b — built for walking the rack:
//   scan a tag → SKU + system quantity appear → type the counted quantity → next
// Scanning the same tag again RETURNS TO THAT LINE rather than duplicating it.
// A running list shows variance; Commit writes one reset per counted SKU.
//
// Bulk count (14 Sep) — "Select many" adds a second way ONTO the same list:
// tick designs in the catalog, type one quantity, stage them. It stages rather
// than commits on purpose. A stock take is a physical count, and a design is
// not a quantity — DD-SAR-PRD-067 is one saree in three sizes but three rows of
// stock, and DD-SUT-PLZ-024 is four colours. The ledger is keyed by SKU and has
// nowhere to hold a design-level number, so "this design is 1" can only execute
// as "write 1 to each of its SKUs", which is rarely what the shelf says. So the
// bulk value lands on the count list as a first draft, per SKU and labelled as
// such, and the operator corrects each size before the one Commit.

const DRAFT_KEY = "drevi:stocktake:draft";

// commitStockTake loops setStock per SKU, ~3 Supabase round trips each, with no
// transaction around the loop. Select-all across the catalog is ~245 SKUs =
// ~735 sequential calls, well past any one function invocation. So the commit
// goes up in chunks: 25 SKUs is ~75 calls, comfortable even on shop wifi, and a
// chunk that dies leaves at most 25 SKUs in doubt instead of the whole take.
// page.tsx raises maxDuration too — belt as well as braces.
const COMMIT_CHUNK = 25;

interface Line extends ScannedSku {
  countedQty: number | null;
}

// A "design" is a base SKU with its variants under it. The picker selects at
// this level because that is how the owner thinks about the rack; the count is
// always written per SKU because that is the only level the ledger has.
interface Design {
  base: string;
  variants: CountableProduct[];
}

// "DD-SAR-PRD-067-L-RST" under base "DD-SAR-PRD-067" → "L-RST". The suffix is
// size AND colour, and showing it is what stops a four-variant design reading
// as four of the same thing.
function variantTag(base: string, sku: string): string {
  return sku.startsWith(`${base}-`) ? sku.slice(base.length + 1) : sku;
}

export function StockTake({ catalog }: { catalog: CountableProduct[] }) {
  const router = useRouter();
  // A stock take is a long walk around a rack — never lose it to a reload.
  const [draft, setDraft, draftMeta] = useDraft<{ lines: Line[]; note: string }>(DRAFT_KEY, { lines: [], note: "" }, {
    hasContent: (d) => d.lines.length > 0 || d.note.trim() !== "",
    onRestore: (d) => ({ lines: d.lines ?? [], note: d.note ?? "" }),
  });
  const { lines, note } = draft;
  const setLines = (u: Line[] | ((prev: Line[]) => Line[])) => setDraft((d) => ({ ...d, lines: typeof u === "function" ? u(d.lines) : u }));
  const setNote = (v: string) => setDraft((d) => ({ ...d, note: v }));
  const [active, setActive] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const qtyRef = useRef<HTMLInputElement | null>(null);
  // Bulk picker. `selected` holds SKUs, never designs — a half-ticked design is
  // a normal state (two of its three sizes counted) and only a SKU set can say so.
  const [picking, setPicking] = useState(false);
  const [pickQuery, setPickQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bulkQty, setBulkQty] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // A chunked commit runs for many seconds; useTransition's pending flag drops
  // at the first await, so the double-submit guard has to be its own latch.
  const committingRef = useRef(false);

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
  const pieces = counted.reduce((s, l) => s + (l.countedQty ?? 0), 0);
  const variance = counted.reduce((s, l) => s + Math.abs((l.countedQty ?? 0) - l.systemQty), 0);

  const designs = useMemo<Design[]>(() => {
    const order: string[] = [];
    const map = new Map<string, CountableProduct[]>();
    for (const p of catalog) {
      const base = baseSkuOf(p.sku);
      if (!map.has(base)) { map.set(base, []); order.push(base); }
      map.get(base)!.push(p);
    }
    return order.map((base) => ({ base, variants: map.get(base)! }));
  }, [catalog]);

  const shown = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    if (!q) return designs;
    return designs.filter((d) =>
      d.base.toLowerCase().includes(q) ||
      d.variants.some((v) =>
        v.sku.toLowerCase().includes(q) ||
        (v.title ?? "").toLowerCase().includes(q) ||
        (v.category ?? "").toLowerCase().includes(q) ||
        (v.location ?? "").toLowerCase().includes(q)),
    );
  }, [designs, pickQuery]);

  const shownSkus = useMemo(() => shown.flatMap((d) => d.variants.map((v) => v.sku)), [shown]);
  const shownSelected = useMemo(() => shownSkus.reduce((n, s) => n + (selected.has(s) ? 1 : 0), 0), [shownSkus, selected]);
  const allShownSelected = shownSkus.length > 0 && shownSelected === shownSkus.length;
  // Selection survives a change of search, so it can hold SKUs the current
  // search does not show. Saying so is the difference between a deliberate
  // multi-search pick and an accident.
  const offSearch = selected.size - shownSelected;
  const filtering = pickQuery.trim() !== "";

  const perSku = bulkQty === "" ? null : Math.max(0, parseInt(bulkQty.replace(/[^\d]/g, ""), 10) || 0);
  const bulkPieces = perSku === null ? null : perSku * selected.size;

  function toggleSkus(skus: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of skus) { if (on) next.add(s); else next.delete(s); }
      return next;
    });
  }

  function toggleExpanded(base: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(base)) next.delete(base); else next.add(base);
      return next;
    });
  }

  /** Put the bulk quantity on the count list for review. Writes nothing. */
  function stage() {
    if (selected.size === 0) { flash("Nothing selected"); return; }
    if (perSku === null) { flash("Type the count per SKU first"); return; }
    // Catalog order (page.tsx sorts by SKU), so the sizes of one design land
    // next to each other and can be corrected one after the other.
    const picked = catalog.filter((p) => selected.has(p.sku));
    setLines((prev) => {
      const have = new Set(prev.map((l) => l.sku));
      return [
        // A SKU already on the list keeps its position and takes the new count,
        // so staging over a scanned line never duplicates it.
        ...prev.map((l) => (selected.has(l.sku) ? { ...l, countedQty: perSku } : l)),
        ...picked.filter((p) => !have.has(p.sku)).map((p) => ({
          sku: p.sku, title: p.title, systemQty: p.systemQty, thumb: p.thumb, location: p.location, countedQty: perSku,
        })),
      ];
    });
    setSelected(new Set());
    setPicking(false);
    setActive(null);
    flash(`${picked.length} SKU${picked.length === 1 ? "" : "s"} staged at ${perSku} each — check every size before you commit`);
  }

  function commit() {
    if (counted.length === 0) { flash("Nothing counted yet"); return; }
    if (committingRef.current) return;
    committingRef.current = true;
    const batch = counted.map((l) => ({ sku: l.sku, countedQty: l.countedQty! }));
    const chunks = Math.ceil(batch.length / COMMIT_CHUNK);
    setProgress({ done: 0, total: batch.length });
    startTransition(async () => {
      const written: string[] = [];
      let stopped: string | null = null;
      let rejected = 0;
      for (let i = 0; i < batch.length; i += COMMIT_CHUNK) {
        const chunk = batch.slice(i, i + COMMIT_CHUNK);
        try {
          const res = await commitCount(chunk, note, { index: i / COMMIT_CHUNK + 1, total: chunks });
          // No `committed` means the chunk never reached the ledger at all
          // (not authorized) — marching on would just repeat the refusal.
          if (res.committed == null) { stopped = res.error ?? "Commit failed"; break; }
          const bad = new Set((res.failed ?? []).map((f) => f.sku));
          for (const c of chunk) if (!bad.has(c.sku)) written.push(c.sku);
          rejected += bad.size;
        } catch {
          // The chunk timed out or the link dropped, so its SKUs are unknown.
          // Earlier chunks ARE in the ledger with no transaction to undo them,
          // so bank what is known-written and leave the rest to a second press.
          stopped = "Commit stopped partway — what was written is off the list, press Commit again for the rest";
          break;
        }
        setProgress({ done: Math.min(i + COMMIT_CHUNK, batch.length), total: batch.length });
      }
      setProgress(null);
      committingRef.current = false;
      const wrote = new Set(written);
      if (wrote.size > 0) router.refresh();
      if (!stopped && rejected === 0 && wrote.size === batch.length) {
        flash(`${wrote.size} SKU${wrote.size === 1 ? "" : "s"} set`);
        draftMeta.discard(); setActive(null);
        return;
      }
      // Whatever landed leaves the list; the remainder stays drafted so another
      // Commit finishes the take instead of rewriting what is already done.
      setLines((prev) => prev.filter((l) => !wrote.has(l.sku)));
      flash(stopped ?? `${wrote.size} of ${batch.length} set — ${batch.length - wrote.size} left on the list`);
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Stock take</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, lineHeight: 1.6, color: palette.softBlack }}>
        Scan a tag, type what you counted, move on — or use <b>Select many</b> to put one quantity
        against a batch of designs. Committing writes an absolute count for each
        SKU on the list — it <b>supersedes earlier receipt arithmetic</b> for those SKUs.
        Anything you don&apos;t count is left completely untouched.
      </p>
      {isDraftOlderThan(draftMeta, DRAFT_NOTICE_AFTER_MS) && <div className="mt-3"><DraftNotice meta={draftMeta} /></div>}

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
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          aria-expanded={picking}
          className="flex items-center gap-2 font-body uppercase"
          style={{
            fontSize: 10, letterSpacing: "0.14em", padding: "11px 14px", fontWeight: 600,
            background: picking ? palette.black : "transparent",
            color: picking ? palette.ivory : palette.black,
            border: picking ? "none" : `1px solid ${palette.black}`,
          }}
        >
          <ListChecks size={14} strokeWidth={2} /> Select many{selected.size > 0 ? ` · ${selected.size}` : ""}
        </button>
      </div>

      {picking && (
        <div className="mt-4" style={{ border: "1px solid rgba(26,26,26,0.18)", background: palette.ivory }}>
          <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.1)" }}>
            <Search size={14} color={palette.mutedGreige} />
            <input
              value={pickQuery}
              onChange={(e) => setPickQuery(e.target.value)}
              placeholder="Search SKU, title, category, location"
              className="font-body bg-transparent outline-none w-full"
              style={{ fontSize: 12.5, color: palette.black }}
            />
            {pickQuery && <button type="button" onClick={() => setPickQuery("")} aria-label="Clear search"><X size={13} color={palette.mutedGreige} /></button>}
          </div>

          {/* Select all means the SHOWN set and says which — ticking 190 designs
              and ticking the 12 a search left on screen must never look alike. */}
          <label className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer" style={{ borderBottom: "1px solid rgba(26,26,26,0.1)", background: palette.ivoryDeep }}>
            <input
              type="checkbox"
              checked={allShownSelected}
              ref={(el) => { if (el) el.indeterminate = shownSelected > 0 && !allShownSelected; }}
              onChange={(e) => toggleSkus(shownSkus, e.target.checked)}
              style={{ accentColor: palette.goldDeep }}
            />
            <span className="font-body" style={{ fontSize: 11.5, color: palette.black }}>
              {filtering
                ? <>Select all <b>{shown.length}</b> design{shown.length === 1 ? "" : "s"} this search found · {shownSkus.length} SKU{shownSkus.length === 1 ? "" : "s"}</>
                : <>Select all <b>{shown.length}</b> designs in the catalog · {shownSkus.length} SKU{shownSkus.length === 1 ? "" : "s"}</>}
            </span>
          </label>

          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {shown.map((d) => {
              const skus = d.variants.map((v) => v.sku);
              const on = skus.reduce((n, s) => n + (selected.has(s) ? 1 : 0), 0);
              const multi = d.variants.length > 1;
              const open = expanded.has(d.base);
              return (
                <div key={d.base} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                  <div className="flex items-center gap-2.5 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={on === skus.length}
                      ref={(el) => { if (el) el.indeterminate = on > 0 && on < skus.length; }}
                      onChange={(e) => toggleSkus(skus, e.target.checked)}
                      aria-label={`Select ${d.base}`}
                      style={{ accentColor: palette.goldDeep }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono truncate" style={{ fontSize: 11, color: palette.black }}>{d.base}</div>
                      <div className="font-body truncate" style={{ fontSize: 10, color: palette.mutedGreige }}>
                        {d.variants[0].title ?? "—"} · system {d.variants.reduce((s, v) => s + v.systemQty, 0)}
                      </div>
                      {multi && (
                        // Its own line, and never truncated — on a phone this is
                        // the only thing standing between "one design" and the
                        // three sizes or four colours it actually is.
                        <div className="font-mono" style={{ fontSize: 9.5, lineHeight: 1.5, color: palette.goldDeep }}>
                          {d.variants.length} SKUs · {d.variants.map((v) => variantTag(d.base, v.sku)).join(" · ")}
                        </div>
                      )}
                    </div>
                    {multi && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(d.base)}
                        aria-label={`${open ? "Hide" : "Show"} the ${d.variants.length} SKUs of ${d.base}`}
                        style={{ color: palette.mutedGreige }}
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </div>
                  {multi && open && d.variants.map((v) => (
                    <label key={v.sku} className="flex items-center gap-2.5 py-1.5 cursor-pointer" style={{ paddingLeft: 34, paddingRight: 12 }}>
                      <input
                        type="checkbox"
                        checked={selected.has(v.sku)}
                        onChange={(e) => toggleSkus([v.sku], e.target.checked)}
                        style={{ accentColor: palette.goldDeep }}
                      />
                      <span className="font-mono" style={{ fontSize: 10.5, color: palette.softBlack }}>{variantTag(d.base, v.sku)}</span>
                      <span className="font-body truncate" style={{ fontSize: 10, color: palette.mutedGreige }}>
                        system {v.systemQty}{v.location ? ` · kept at ${v.location}` : ""}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })}
            {shown.length === 0 && (
              <div className="font-body py-8 text-center" style={{ fontSize: 11.5, color: palette.mutedGreige }}>Nothing matches that search.</div>
            )}
          </div>

          <div className="px-3 py-3" style={{ borderTop: "1px solid rgba(26,26,26,0.12)", background: palette.ivoryDeep }}>
            {selected.size === 0 ? (
              <div className="font-body" style={{ fontSize: 10.5, lineHeight: 1.55, color: palette.mutedGreige }}>
                Tick the designs you counted. A design with more than one SKU is more than one thing on the
                rack — open it to tick sizes and colours one at a time.
              </div>
            ) : (
              <>
                <div className="flex items-end gap-2 flex-wrap">
                  <div>
                    <label htmlFor="bulk-qty" className="font-body uppercase block" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>
                      Count per SKU
                    </label>
                    <input
                      id="bulk-qty"
                      value={bulkQty}
                      onChange={(e) => setBulkQty(e.target.value)}
                      inputMode="numeric"
                      placeholder="0"
                      className="font-body text-center mt-1"
                      style={{ width: 72, fontSize: 13, padding: "7px 4px", border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={stage}
                    disabled={perSku === null}
                    className="font-body uppercase disabled:opacity-40"
                    style={{ fontSize: 10, letterSpacing: "0.14em", background: palette.gold, color: palette.black, padding: "11px 14px", fontWeight: 600 }}
                  >
                    Stage {selected.size} SKU{selected.size === 1 ? "" : "s"}, {bulkPieces ?? "—"} piece{bulkPieces === 1 ? "" : "s"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="font-body uppercase"
                    style={{ fontSize: 9.5, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "10px 12px" }}
                  >
                    Clear
                  </button>
                </div>
                <div className="font-body mt-2" style={{ fontSize: 10.5, lineHeight: 1.55, color: palette.softBlack }}>
                  <b>{selected.size}</b> SKU{selected.size === 1 ? "" : "s"} selected
                  {offSearch > 0 ? ` — ${offSearch} of them the current search does not show` : ""}. The quantity is
                  written <b>per SKU</b>, not per design, so this stages <b>{bulkPieces ?? "—"} piece{bulkPieces === 1 ? "" : "s"}</b>{" "}
                  in total. Nothing reaches the ledger yet — correct each size on the list below, then commit once.
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
                    {l.title ?? "—"} · system {l.systemQty}{l.location ? ` · kept at ${l.location}` : ""}
                  </div>
                </div>
                <input
                  ref={active === l.sku ? qtyRef : undefined}
                  value={l.countedQty ?? ""}
                  onChange={(e) => setQty(l.sku, e.target.value)}
                  onFocus={() => setActive(l.sku)}
                  inputMode="numeric"
                  placeholder="count"
                  // Frozen mid-commit: the batch was snapshotted when Commit was
                  // pressed and written rows are pruned from a FRESH list after,
                  // so an edit made now would vanish with the row it belongs to.
                  disabled={progress !== null}
                  className="font-body text-center disabled:opacity-50"
                  style={{ width: 66, fontSize: 13, padding: "7px 4px", border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black }}
                />
                <span className="font-body" style={{ width: 52, textAlign: "right", fontSize: 11, fontWeight: 600, color: diff === null ? palette.mutedGreige : diff === 0 ? "#1F6B45" : "#9C3A31" }}>
                  {diff === null ? "—" : diff > 0 ? `+${diff}` : diff}
                </span>
                <button
                  type="button"
                  onClick={() => setLines((p) => p.filter((x) => x.sku !== l.sku))}
                  disabled={progress !== null}
                  aria-label={`Remove ${l.sku}`}
                  className="disabled:opacity-40"
                  style={{ color: palette.mutedGreige }}
                >
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
              — <b>{pieces} piece{pieces === 1 ? "" : "s"}</b> on the shelf
              {variance > 0 ? `, total variance ${variance} pcs` : ""}. Earlier movements stay as history but stop
              counting toward stock. The other {lines.length - counted.length} line
              {lines.length - counted.length === 1 ? "" : "s"} with no count, and every SKU that is not on this
              list at all, are untouched.
              {counted.length > COMMIT_CHUNK && (
                <> This goes up in batches of {COMMIT_CHUNK}, and there is no rollback across batches: if it
                stops partway the SKUs already written stay written and drop off this list, and the rest wait
                here for another Commit.</>
              )}
            </div>
          </div>
          {progress ? (
            <div className="mt-3 font-body" style={{ fontSize: 11, color: palette.softBlack }}>
              Committing {progress.done} of {progress.total} — keep this screen open.
              <div className="mt-1.5" style={{ height: 3, background: "rgba(26,26,26,0.1)" }}>
                <div style={{ height: 3, width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`, background: palette.goldDeep, transition: "width 160ms linear" }} />
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={commit}
              disabled={pending}
              className="mt-3 flex items-center gap-2 font-body uppercase disabled:opacity-40"
              style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.black, color: palette.ivory, padding: "12px 18px" }}
            >
              <Check size={14} /> Commit {counted.length} count{counted.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}

      {lines.length === 0 && (
        <div className="font-body py-10 text-center" style={{ fontSize: 12, color: palette.mutedGreige }}>
          Nothing on the list yet. Scan a tag, or pick designs with Select many.
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

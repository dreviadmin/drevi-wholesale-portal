"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Search, X, ScanLine, ImageOff, Check, Crown } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { useSort, SortTh } from "@/components/sortable";
import { withFrom } from "@/components/BackLink";
import { palette } from "@/lib/palette";
import { useToast } from "@/lib/use-toast";
import { BatchProgress, type BatchProgressState } from "@/components/admin/BatchProgress";
import { BADGE_LABEL, type DesignBadge } from "@/lib/studio/state";
import type { BoardRow } from "@/lib/studio/load";
import { setTierBatch, togglePortalBatch, runFashnBatch, approveAllPreflight, approveAllBatch, generateCopyBatch, pushWholesaleBatch, pushShopifyBatch } from "./actions";
import { JobsTicker } from "./JobsTicker";

// Studio board (§7.4): derived-state chips with live counts, rows with
// thumb/badge/dot-strip, multiselect batch bar. Spend/push batch actions are
// visible but disabled until their stages land (D8: no spend without an
// estimate — and no runner yet).

// Server-side caps, mirrored here so the button can feed the action in chunks
// instead of silently truncating the selection. Keep in step with
// generateCopyBatch / pushWholesaleBatch / pushShopifyBatch.
const COPY_CHUNK = 10;
const PUSH_CHUNK = 20;

const CHIP_ORDER: (DesignBadge | "all")[] = ["all", "awaiting_specs", "needs_photos", "in_review", "needs_copy", "ready", "live", "changes_pending"];

const BADGE_STYLE: Record<DesignBadge, { bg: string; fg: string }> = {
  awaiting_specs: { bg: "#EFE7DA", fg: "#7A6A4F" },
  needs_photos: { bg: "#F6E7CB", fg: "#8a6d1a" },
  in_review: { bg: "#E4EAF1", fg: "#40608a" },
  needs_copy: { bg: "#EBE4F4", fg: "#5F4B8B" },
  ready: { bg: "#DFF0E4", fg: "#1F6B45" },
  live: { bg: "#14532D", fg: "#E8F5EC" },
  changes_pending: { bg: "#F7DFDC", fg: "#9C3A31" },
};

const fmtAdded = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");

export function StudioBoard({ rows }: { rows: BoardRow[] }) {
  const router = useRouter();
  const [chip, setChip] = useState<DesignBadge | "all">("all");
  // Rakesh's confirmation is a SEPARATE axis from the badge, not another chip:
  // deriveBadge reports "Live" before it looks at specs, so a live design whose
  // specs were never ticked carries no awaiting_specs badge. Grishma needs the
  // designs Rakesh has signed off (copy generation is gated on exactly this
  // flag), and Rakesh needs the ones he has not reached yet — neither list is
  // a badge. ANDs with the chip and the search box.
  const [specsFilter, setSpecsFilter] = useState<"any" | "confirmed" | "awaiting">("any");
  // Photo count is MULTI-select, unlike the badge chips (Ansh, 20 Sep: "can
  // select 1/6 and 3/6 at the same time"). The question it answers is "what is
  // half-shot" — and the sparse counts are not adjacent, so a single pick or a
  // range would both be the wrong shape. Empty set = no filter.
  const [photoCounts, setPhotoCounts] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toast, flash, dismissToast] = useToast();
  const [progress, setProgress] = useState<BatchProgressState | null>(null);
  // A ref, not state: the bulk loops run inside a transition and read this
  // BETWEEN chunks, where a state value captured at the start would be stale
  // forever. Setting it is what "Stop" does.
  const stopRef = useRef(false);
  const [pending, startTransition] = useTransition();
  // D8 confirm sheets: FASHN spend (count + credits) and use-candidates (thumbnails).
  const [confirm, setConfirm] = useState<
    | { kind: "fashn"; jobs: number; credits: number }
    | { kind: "approve"; items: { candidateId: string; fileRef: string; label: string }[] }
    | null
  >(null);

  // Cockpit deep-links land pre-filtered: /admin/studio?state=needs_photos
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("state");
    if (s && (CHIP_ORDER as string[]).includes(s)) setChip(s as DesignBadge);
    const sp = params.get("specs");
    if (sp === "confirmed" || sp === "awaiting") setSpecsFilter(sp);
    const ph = params.get("photos");
    if (ph) {
      const picked = ph.split(",").map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      if (picked.length) setPhotoCounts(new Set(picked));
    }
  }, []);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) c.set(r.badge, (c.get(r.badge) ?? 0) + 1);
    return c;
  }, [rows]);

  const specsCounts = useMemo(() => {
    const confirmed = rows.filter((r) => r.specsVerified).length;
    return { confirmed, awaiting: rows.length - confirmed };
  }, [rows]);

  const photoCountTotals = useMemo(() => {
    const c = new Array(7).fill(0) as number[];
    for (const r of rows) if (r.filledCount >= 0 && r.filledCount <= 6) c[r.filledCount] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows.filter((r) => {
      if (chip !== "all" && r.badge !== chip) return false;
      if (specsFilter === "confirmed" && !r.specsVerified) return false;
      if (specsFilter === "awaiting" && r.specsVerified) return false;
      if (photoCounts.size > 0 && !photoCounts.has(r.filledCount)) return false;
      if (!q) return true;
      return [r.baseSku, r.color, r.title ?? "", r.category ?? ""].some((v) => v.toUpperCase().includes(q));
    });
  }, [rows, chip, specsFilter, photoCounts, query]);

  const { sorted, sort, toggle } = useSort(filtered, {
    sku: (r) => `${r.baseSku}-${r.color}`,
    title: (r) => r.title ?? "",
    badge: (r) => r.badgeLabel,
    photos: (r) => r.filledCount,
    tier: (r) => r.tier,
    // Numeric on purpose: useSort compares strings with localeCompare({numeric:true}),
    // which mis-orders ISO fractional seconds of unequal length.
    added: (r) => (r.createdAt ? Date.parse(r.createdAt) : null),
  }, { key: "added", dir: "desc" });

  // Progress lives beside the toast, not inside it: a toast answers "what just
  // happened", the meter answers "how much longer". A 17-minute copy run needs
  // both (Ansh, 22 Sep).
  function runProgress(label: string, done: number, total: number, detail?: string) {
    setProgress({ label, done, total, detail, stopping: stopRef.current });
  }
  function endProgress(label: string, total: number, detail: string, done?: number) {
    setProgress({ label, done: done ?? total, total, detail, finished: true });
  }
  // Stop takes effect at the next chunk boundary. The chunk already in flight
  // is a server action on its way to Anthropic or Shopify — it finishes and is
  // counted, because pretending otherwise would misreport what was spent.
  function requestStop() {
    stopRef.current = true;
    setProgress((p) => (p && !p.finished ? { ...p, stopping: true } : p));
    flash("Stopping after the designs already sent — no new ones will start.");
  }
  function startRun() { stopRef.current = false; }

  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    setQuery(sku.split("-").slice(0, 4).join("-"));
    setScanOpen(false);
    return { ok: true, message: sku };
  }

  function toggleRow(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function runBatch(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) { flash(done); setSelected(new Set()); router.refresh(); }
      else flash(res.error ?? "Failed");
    });
  }

  const ids = [...selected];
  const dot = (on: boolean) => (on ? "✓" : "○");
  // Carry the active filters so the workbench's back link lands on the same
  // list — Grishma works down her filtered set one design at a time.
  const boardHref = (() => {
    const p = new URLSearchParams();
    if (chip !== "all") p.set("state", chip);
    if (specsFilter !== "any") p.set("specs", specsFilter);
    if (photoCounts.size > 0) p.set("photos", [...photoCounts].sort((a, b) => a - b).join(","));
    const q = p.toString();
    return q ? `/admin/studio?${q}` : "/admin/studio";
  })();
  const openRow = (id: string) => router.push(withFrom(`/admin/studio/${id}`, boardHref));

  const rowCard = (r: BoardRow) => (
    <div key={r.id} className="flex items-center gap-3 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} aria-label={`Select ${r.baseSku}`} style={{ accentColor: palette.goldDeep }} />
      <button type="button" onClick={() => openRow(r.id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
        {r.thumb ? (
          <Image src={r.thumb} alt={r.baseSku} width={44} height={55} className="object-cover flex-shrink-0" unoptimized />
        ) : (
          <span className="flex items-center justify-center flex-shrink-0" style={{ width: 44, height: 55, background: palette.ivoryDeep }}>
            <ImageOff size={15} color={palette.mutedGreige} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="font-mono block truncate" style={{ fontSize: 12, fontWeight: 700, color: palette.black }}>
            {r.baseSku} · {r.color} {r.tier === "hero" && <Crown size={11} className="inline" color={palette.goldDeep} />}
          </span>
          <span className="font-body block truncate" style={{ fontSize: 11.5, color: palette.softBlack }}>{r.title ?? "—"}</span>
          <span className="font-mono block mt-0.5" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
            {dot(r.specsVerified)} specs · ◑ {r.filledCount}/6 · {dot(r.copyPresent)} copy ·{" "}
            {r.targets.map((t) => `${t.state === "live" ? "▪" : "▫"}${t.portal === "wholesale" ? "WS" : "SH"}`).join(" ")}
            {` · added ${fmtAdded(r.createdAt)}`}
            {r.notifyCount > 0 ? ` · 🔔 ${r.notifyCount}` : ""}
          </span>
        </span>
        <span className="font-body uppercase flex-shrink-0 px-2 py-1" style={{ fontSize: 8.5, letterSpacing: "0.1em", fontWeight: 600, background: BADGE_STYLE[r.badge].bg, color: BADGE_STYLE[r.badge].fg }}>
          {r.badgeLabel}
        </span>
      </button>
    </div>
  );

  return (
    <div className="px-4 md:px-8 py-6 max-w-5xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Studio</h1>
          <p className="font-body mt-1" style={{ fontSize: 11.5, color: palette.mutedGreige }}>
            {rows.length} designs · photos, copy and publishing converge here.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const res = await fetch("/api/pipeline/jobs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "scan_drive", params: { all: true } }),
              });
              const d = await res.json();
              flash(res.ok ? "Drive backfill queued" : d.error ?? "Failed");
              router.refresh();
            });
          }}
          className="font-body uppercase disabled:opacity-50"
          style={{ fontSize: 9.5, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "9px 12px" }}
        >
          Backfill from Drive
        </button>
      </div>
      <JobsTicker />

      {/* Search + scan (golden rule 1) */}
      <div className="flex items-center gap-2 mt-4 p-2.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <Search size={15} color={palette.mutedGreige} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search base SKU, colour, name"
          className="flex-1 font-body bg-transparent outline-none"
          style={{ fontSize: 13, color: palette.black }}
        />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear"><X size={14} color={palette.mutedGreige} /></button>}
        <button type="button" onClick={() => setScanOpen(true)} className="flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 12px" }}>
          <ScanLine size={12} /> Scan
        </button>
      </div>

      {/* Derived-state chips with live counts */}
      <div className="flex gap-1.5 mt-3 overflow-x-auto no-scrollbar">
        {CHIP_ORDER.map((c) => {
          const n = c === "all" ? rows.length : counts.get(c) ?? 0;
          const active = chip === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setChip(c)}
              className="font-body uppercase whitespace-nowrap"
              style={{
                fontSize: 9.5, letterSpacing: "0.1em", padding: "7px 11px",
                background: active ? palette.black : palette.ivory,
                color: active ? palette.ivory : palette.softBlack,
                border: "1px solid rgba(26,26,26,0.12)",
              }}
            >
              {c === "all" ? "All" : BADGE_LABEL[c]} · {n}
            </button>
          );
        })}
      </div>

      {/* Rakesh's sign-off — a second axis, so it is labelled rather than
          dropped into the chip row as if it were another badge. Each button
          toggles off, and the two are mutually exclusive. */}
      <div className="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar">
        <span className="font-body uppercase whitespace-nowrap" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Specs</span>
        {([
          { key: "confirmed", label: "Confirmed by Rakesh", n: specsCounts.confirmed },
          { key: "awaiting", label: "Awaiting Rakesh", n: specsCounts.awaiting },
        ] as const).map((f) => {
          const active = specsFilter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={active}
              onClick={() => setSpecsFilter(active ? "any" : f.key)}
              className="flex items-center gap-1 font-body uppercase whitespace-nowrap"
              style={{
                fontSize: 9.5, letterSpacing: "0.1em", padding: "7px 11px",
                background: active ? palette.goldDeep : palette.ivory,
                color: active ? palette.ivory : palette.softBlack,
                border: `1px solid ${active ? palette.goldDeep : "rgba(26,26,26,0.12)"}`,
              }}
            >
              {f.key === "confirmed" && <Check size={11} />}
              {f.label} · {f.n}
            </button>
          );
        })}
      </div>

      {/* Select-all over the FILTERED set, not the whole board (Ansh, 21 Sep:
          "add a select all option as well so that I don't have to select each
          manually"). Filtered is the only sane meaning: the point of filtering
          to Ready is to act on exactly those, and a control that quietly
          selected all 283 designs behind a filter showing 101 would be a trap
          in front of buttons that spend money and publish. */}
      {sorted.length > 0 && (
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => {
              const shown = sorted.map((r) => r.id);
              const allOn = shown.every((id) => selected.has(id));
              setSelected((prev) => {
                const next = new Set(prev);
                for (const id of shown) { if (allOn) next.delete(id); else next.add(id); }
                return next;
              });
            }}
            className="font-body uppercase"
            style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", padding: "6px 10px" }}
          >
            {sorted.every((r) => selected.has(r.id)) ? `Clear these ${sorted.length}` : `Select all ${sorted.length}`}
          </button>
          {selected.size > 0 && (
            <button type="button" onClick={() => setSelected(new Set())} className="font-body uppercase"
              style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.mutedGreige, background: "transparent", border: "none", padding: "6px 2px" }}>
              Clear selection ({selected.size})
            </button>
          )}
        </div>
      )}

      {/* Photo count — MULTI-select, so "1/6 and 3/6 at once" works. Every
          count keeps its slot even at zero: a row that reshuffles under the
          thumb is worse than a chip that reads 0. */}
      <div className="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar">
        <span className="font-body uppercase whitespace-nowrap" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Photos</span>
        {photoCountTotals.map((n, i) => {
          const active = photoCounts.has(i);
          return (
            <button
              key={i}
              type="button"
              aria-pressed={active}
              onClick={() =>
                setPhotoCounts((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i); else next.add(i);
                  return next;
                })
              }
              className="font-body uppercase whitespace-nowrap"
              style={{
                fontSize: 9.5, letterSpacing: "0.1em", padding: "7px 10px",
                background: active ? palette.black : palette.ivory,
                color: active ? palette.ivory : n === 0 ? palette.mutedGreige : palette.softBlack,
                border: "1px solid rgba(26,26,26,0.12)",
              }}
            >
              {i}/6 · {n}
            </button>
          );
        })}
        {photoCounts.size > 0 && (
          <button type="button" onClick={() => setPhotoCounts(new Set())} aria-label="Clear photo filter" className="font-body uppercase whitespace-nowrap" style={{ fontSize: 9, letterSpacing: "0.1em", padding: "7px 8px", color: palette.mutedGreige, background: "transparent", border: "none" }}>
            Clear
          </button>
        )}
      </div>

      {/* Mobile cards */}
      <div className="md:hidden mt-3 flex flex-col gap-1.5 pb-24">
        {sorted.map(rowCard)}
        {sorted.length === 0 && <div className="font-body py-8 text-center" style={{ fontSize: 12, color: palette.mutedGreige }}>No designs match.</div>}
      </div>

      {/* Desktop sortable table (golden rule 3) */}
      <div className="hidden md:block mt-3 overflow-x-auto pb-24">
        <table className="w-full" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              <th style={{ width: 30 }} />
              <th style={{ width: 54 }} />
              <SortTh label="Design" k="sku" sort={sort} onToggle={toggle} />
              <SortTh label="Name" k="title" sort={sort} onToggle={toggle} />
              <SortTh label="State" k="badge" sort={sort} onToggle={toggle} />
              <SortTh label="Photos" k="photos" sort={sort} onToggle={toggle} right defaultDir="desc" />
              <SortTh label="Tier" k="tier" sort={sort} onToggle={toggle} />
              <SortTh label="Added" k="added" sort={sort} onToggle={toggle} right defaultDir="desc" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="cursor-pointer" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }} onClick={() => openRow(r.id)}>
                <td onClick={(e) => e.stopPropagation()} style={{ padding: "8px 4px" }}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} aria-label={`Select ${r.baseSku}`} style={{ accentColor: palette.goldDeep }} />
                </td>
                <td style={{ padding: "8px 4px" }}>
                  {r.thumb ? <Image src={r.thumb} alt="" width={36} height={45} className="object-cover" unoptimized /> : <span className="inline-flex items-center justify-center" style={{ width: 36, height: 45, background: palette.ivoryDeep }}><ImageOff size={12} color={palette.mutedGreige} /></span>}
                </td>
                <td className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: palette.black, padding: "8px 6px" }}>
                  {r.baseSku} · {r.color} {r.tier === "hero" && <Crown size={11} className="inline" color={palette.goldDeep} />}
                </td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "8px 6px", maxWidth: 260 }}>{r.title ?? "—"}</td>
                <td style={{ padding: "8px 6px" }}>
                  <span className="font-body uppercase px-2 py-1" style={{ fontSize: 8.5, letterSpacing: "0.1em", fontWeight: 600, background: BADGE_STYLE[r.badge].bg, color: BADGE_STYLE[r.badge].fg }}>{r.badgeLabel}</span>
                </td>
                <td className="font-mono text-right" style={{ fontSize: 11.5, color: palette.softBlack, padding: "8px 6px" }}>{r.filledCount}/6</td>
                <td className="font-body uppercase" style={{ fontSize: 10, color: r.tier === "hero" ? palette.goldDeep : palette.mutedGreige, padding: "8px 6px" }}>{r.tier}</td>
                <td className="font-mono text-right" style={{ fontSize: 10.5, color: palette.mutedGreige, padding: "8px 6px", whiteSpace: "nowrap" }}>{fmtAdded(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="font-body py-8 text-center" style={{ fontSize: 12, color: palette.mutedGreige }}>No designs match.</div>}
      </div>

      {/* Toast, meter and batch bar are ONE bottom stack. They were three fixed
          elements with hand-picked offsets, and the offsets were wrong the
          moment the bar wrapped onto a second row of buttons — the meter
          covered them. A flex column cannot overlap itself. */}
      {(selected.size > 0 || progress || toast) && (
        <div className="fixed bottom-16 md:bottom-4 inset-x-0 z-40 mx-auto max-w-2xl px-3 flex flex-col gap-2 pointer-events-none">
          {toast && (
            <button
              type="button"
              onClick={dismissToast}
              className="self-center font-body px-4 py-2 flex items-center gap-2 text-left pointer-events-auto"
              style={{ background: palette.black, color: palette.ivory, fontSize: 12, maxWidth: "100%" }}
              aria-live="polite"
            >
              <Check size={13} color={palette.gold} /> {toast}
            </button>
          )}

          <div className="pointer-events-auto">
            <BatchProgress state={progress} onDismiss={() => setProgress(null)} onStop={requestStop} />
          </div>

          {selected.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap p-3 pointer-events-auto" style={{ background: palette.black, boxShadow: "0 6px 24px rgba(0,0,0,0.35)" }}>
            <span className="font-body" style={{ fontSize: 11, color: palette.champagne }}>{selected.size} selected</span>
            <span className="flex-1" />
            <button type="button" disabled={pending} onClick={() => runBatch(() => setTierBatch(ids, "hero"), "Tier set to hero")} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.black, background: palette.gold, padding: "8px 10px" }}>Set hero</button>
            <button type="button" disabled={pending} onClick={() => runBatch(() => setTierBatch(ids, "standard"), "Tier set to standard")} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}>Set standard</button>
            <button type="button" disabled={pending} onClick={() => runBatch(() => togglePortalBatch(ids, "shopify", false), "Shopify disabled")} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}>SH off</button>
            <button type="button" disabled={pending} onClick={() => runBatch(() => togglePortalBatch(ids, "shopify", true), "Shopify enabled")} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}>SH on</button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  const pre = await runFashnBatch(ids, true);
                  if (!pre.ok || !pre.jobs) { flash(pre.error ?? "No pending AI angles in the selection"); return; }
                  setConfirm({ kind: "fashn", jobs: pre.jobs, credits: pre.credits ?? 0 });
                });
              }}
              className="font-body uppercase disabled:opacity-50"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.black, background: palette.gold, padding: "8px 10px" }}
            >
              Run FASHN
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  const pre = await approveAllPreflight(ids);
                  if (!pre.ok || !pre.items?.length) { flash(pre.error ?? "No new candidates in the selection"); return; }
                  setConfirm({ kind: "approve", items: pre.items });
                });
              }}
              className="font-body uppercase disabled:opacity-50"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}
            >
              Use candidates
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Generate copy for ${ids.length} design(s)? One vision call each; unverified specs are skipped. Runs in batches of ${COPY_CHUNK} — leave this tab open.`)) return;
                startTransition(async () => {
                  // The ACTION caps at 10 because each design is one Opus
                  // vision call run sequentially inside a Vercel function with
                  // a 60s ceiling — ten is about what fits. Selecting 101 used
                  // to silently do ten and drop the rest. The cap stays where
                  // it belongs, on the server; the button now feeds it in
                  // chunks so one click means one click. (Ansh, 21 Sep.)
                  let gen = 0, skip = 0, fail = 0, done = 0;
                  startRun();
                  runProgress("Generating copy", 0, ids.length, "one vision call per design");
                  for (let i = 0; i < ids.length; i += COPY_CHUNK) {
                    if (stopRef.current) {
                      endProgress("Generating copy", ids.length, `stopped at ${done} of ${ids.length} · ${gen} generated · ${skip} awaiting specs`, done);
                      flash(`Stopped. ${gen} generated · ${skip} awaiting specs · ${ids.length - done} not started`);
                      return;
                    }
                    const chunk = ids.slice(i, i + COPY_CHUNK);
                    const r = await generateCopyBatch(chunk);
                    if (!r.ok) {
                      flash(r.error ?? "Failed");
                      endProgress("Generating copy", ids.length, `stopped at ${done} of ${ids.length} — ${r.error ?? "failed"}`);
                      break;
                    }
                    gen += r.generated ?? 0; skip += r.skipped ?? 0; fail += r.failed ?? 0;
                    done += chunk.length;
                    const tally = `${gen} generated · ${skip} awaiting specs${fail ? ` · ${fail} failed` : ""}`;
                    runProgress("Generating copy", done, ids.length, tally);
                    flash(`Copy ${done}/${ids.length} · ${tally}`);
                  }
                  if (done === ids.length) {
                    endProgress("Generating copy", ids.length, `${gen} generated · ${skip} awaiting specs · ${fail} failed`);
                    flash(`Copy done: ${gen} generated · ${skip} awaiting specs · ${fail} failed`);
                  }
                  router.refresh();
                });
              }}
              className="font-body uppercase disabled:opacity-50"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}
            >
              Generate copy
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Push ${ids.length} design(s) to wholesale? Gate-blocked designs are skipped and reported.`)) return;
                startTransition(async () => {
                  let pushed = 0, blocked = 0, failed = 0, done = 0;
                  startRun();
                  runProgress("Pushing to wholesale", 0, ids.length);
                  for (let i = 0; i < ids.length; i += PUSH_CHUNK) {
                    if (stopRef.current) {
                      endProgress("Pushing to wholesale", ids.length, `stopped at ${done} of ${ids.length} · ${pushed} pushed`, done);
                      flash(`Stopped. ${pushed} pushed · ${ids.length - done} not started`);
                      router.refresh();
                      return;
                    }
                    const chunk = ids.slice(i, i + PUSH_CHUNK);
                    const r = await pushWholesaleBatch(chunk);
                    if (!r.ok) {
                      flash(r.error ?? "Failed");
                      endProgress("Pushing to wholesale", ids.length, `stopped at ${done} of ${ids.length} — ${r.error ?? "failed"}`);
                      break;
                    }
                    pushed += r.pushed ?? 0; blocked += r.blocked ?? 0; failed += r.failed ?? 0;
                    done += chunk.length;
                    const tally = `${pushed} pushed · ${blocked} blocked${failed ? ` · ${failed} failed` : ""}`;
                    runProgress("Pushing to wholesale", done, ids.length, tally);
                    flash(`Wholesale ${done}/${ids.length} · ${tally}`);
                  }
                  if (done === ids.length) {
                    endProgress("Pushing to wholesale", ids.length, `${pushed} pushed · ${blocked} gate-blocked · ${failed} failed`);
                    flash(`Wholesale done: ${pushed} pushed · ${blocked} gate-blocked · ${failed} failed`);
                  }
                  router.refresh();
                });
              }}
              className="font-body uppercase disabled:opacity-50"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.black, background: palette.gold, padding: "8px 10px" }}
            >
              Push WS
            </button>
            {/* The one bulk route that did not exist (21 Sep). Same cap and the
                same honest reporting as its wholesale twin — and it names the
                first real failure, because "3 failed" on its own sends the
                operator hunting through twenty designs. */}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Push ${ids.length} design(s) to Shopify? New products are created as DRAFT; gate-blocked designs are skipped and reported.`)) return;
                startTransition(async () => {
                  let pushed = 0, blocked = 0, failed = 0, done = 0, firstError = "";
                  startRun();
                  runProgress("Pushing to Shopify", 0, ids.length, "new products are created as DRAFT");
                  for (let i = 0; i < ids.length; i += PUSH_CHUNK) {
                    if (stopRef.current) {
                      endProgress("Pushing to Shopify", ids.length, `stopped at ${done} of ${ids.length} · ${pushed} pushed`, done);
                      flash(`Stopped. ${pushed} pushed · ${ids.length - done} not started`);
                      router.refresh();
                      return;
                    }
                    const chunk = ids.slice(i, i + PUSH_CHUNK);
                    const r = await pushShopifyBatch(chunk);
                    if (!r.ok) {
                      flash(r.error ?? "Failed");
                      endProgress("Pushing to Shopify", ids.length, `stopped at ${done} of ${ids.length} — ${r.error ?? "failed"}`);
                      break;
                    }
                    pushed += r.pushed ?? 0; blocked += r.blocked ?? 0; failed += r.failed ?? 0;
                    if (!firstError && r.firstError) firstError = r.firstError;
                    done += chunk.length;
                    const tally = `${pushed} pushed · ${blocked} blocked${failed ? ` · ${failed} failed` : ""}`;
                    runProgress("Pushing to Shopify", done, ids.length, tally);
                    flash(`Shopify ${done}/${ids.length} · ${tally}`);
                  }
                  if (done === ids.length) {
                    endProgress("Pushing to Shopify", ids.length, `${pushed} pushed · ${blocked} gate-blocked · ${failed} failed${firstError ? ` — ${firstError}` : ""}`);
                    flash(`Shopify done: ${pushed} pushed · ${blocked} gate-blocked · ${failed} failed${firstError ? ` — ${firstError}` : ""}`);
                  }
                  router.refresh();
                });
              }}
              className="font-body uppercase disabled:opacity-50"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.black, background: palette.gold, padding: "8px 10px" }}
            >
              Push SH
            </button>
          </div>
          )}
        </div>
      )}

      {/* D8 confirm sheets */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.55)" }} onClick={() => setConfirm(null)}>
          <div className="w-full md:w-[440px] max-h-modal overflow-y-auto p-5" style={{ background: palette.ivory }} onClick={(e) => e.stopPropagation()}>
            {confirm.kind === "fashn" ? (
              <>
                <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>Run FASHN</div>
                <p className="font-body mt-2" style={{ fontSize: 13, color: palette.black }}>
                  {confirm.jobs} render job{confirm.jobs === 1 ? "" : "s"} · estimated <b>{confirm.credits} credits</b> (1k · balanced).
                </p>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { setConfirm(null); runBatch(() => runFashnBatch(ids, false).then((r) => ({ ok: r.ok, error: r.error })), "FASHN jobs queued"); }}
                  className="mt-4 w-full font-body uppercase disabled:opacity-50"
                  style={{ fontSize: 10.5, letterSpacing: "0.18em", background: palette.gold, color: palette.black, fontWeight: 600, padding: "12px 0" }}
                >
                  Spend {confirm.credits} credits
                </button>
              </>
            ) : (
              <>
                {/* Approval is no longer a gate (17 Sep) — this promotes each
                    angle's newest candidate to its production image, replacing
                    the source in the published set. Labelled for what it does. */}
                <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>
                  Use {confirm.items.length} candidate{confirm.items.length === 1 ? "" : "s"} as production
                </div>
                <div className="grid grid-cols-4 gap-2 mt-3">
                  {confirm.items.map((it) => (
                    <div key={it.candidateId}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/drive-photo?id=${encodeURIComponent(it.fileRef)}&s=200`} alt={it.label} style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover", background: palette.ivoryDeep }} />
                      <div className="font-mono truncate" style={{ fontSize: 7, color: palette.mutedGreige }}>{it.label}</div>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { const idsToApprove = confirm.items.map((i) => i.candidateId); setConfirm(null); runBatch(() => approveAllBatch(idsToApprove).then((r) => ({ ok: r.ok, error: r.error })), "Candidates set as production"); }}
                  className="mt-4 w-full font-body uppercase disabled:opacity-50"
                  style={{ fontSize: 10.5, letterSpacing: "0.18em", background: "#1F6B45", color: "#fff", fontWeight: 600, padding: "12px 0" }}
                >
                  Use all shown
                </button>
              </>
            )}
            <button type="button" onClick={() => setConfirm(null)} className="mt-2 w-full font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", color: palette.softBlack, padding: "8px 0" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {scanOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.55)" }} onClick={() => setScanOpen(false)}>
          <div className="w-full md:w-[420px] p-4" style={{ background: palette.ivory }} onClick={(e) => e.stopPropagation()}>
            <QrScanner onScan={handleScan} onClose={() => setScanOpen(false)} />
          </div>
        </div>
      )}

    </div>
  );
}

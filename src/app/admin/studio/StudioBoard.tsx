"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Search, X, ScanLine, ImageOff, Check, Crown } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { useSort, SortTh } from "@/components/sortable";
import { palette } from "@/lib/palette";
import { BADGE_LABEL, type DesignBadge } from "@/lib/studio/state";
import type { BoardRow } from "@/lib/studio/load";
import { setTierBatch, togglePortalBatch, runFashnBatch, approveAllPreflight, approveAllBatch } from "./actions";
import { JobsTicker } from "./JobsTicker";

// Studio board (§7.4): derived-state chips with live counts, rows with
// thumb/badge/dot-strip, multiselect batch bar. Spend/push batch actions are
// visible but disabled until their stages land (D8: no spend without an
// estimate — and no runner yet).

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

export function StudioBoard({ rows }: { rows: BoardRow[] }) {
  const router = useRouter();
  const [chip, setChip] = useState<DesignBadge | "all">("all");
  const [query, setQuery] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // D8 confirm sheets: FASHN spend (count + credits) and batch-approve (thumbnails).
  const [confirm, setConfirm] = useState<
    | { kind: "fashn"; jobs: number; credits: number }
    | { kind: "approve"; items: { candidateId: string; fileRef: string; label: string }[] }
    | null
  >(null);

  // Cockpit deep-links land pre-filtered: /admin/studio?state=needs_photos
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("state");
    if (s && (CHIP_ORDER as string[]).includes(s)) setChip(s as DesignBadge);
  }, []);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) c.set(r.badge, (c.get(r.badge) ?? 0) + 1);
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows.filter((r) => {
      if (chip !== "all" && r.badge !== chip) return false;
      if (!q) return true;
      return [r.baseSku, r.color, r.title ?? "", r.category ?? ""].some((v) => v.toUpperCase().includes(q));
    });
  }, [rows, chip, query]);

  const { sorted, sort, toggle } = useSort(filtered, {
    sku: (r) => `${r.baseSku}-${r.color}`,
    title: (r) => r.title ?? "",
    badge: (r) => r.badgeLabel,
    photos: (r) => r.approvedAiCount,
    tier: (r) => r.tier,
  });

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

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

  const rowCard = (r: BoardRow) => (
    <div key={r.id} className="flex items-center gap-3 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} aria-label={`Select ${r.baseSku}`} style={{ accentColor: palette.goldDeep }} />
      <button type="button" onClick={() => router.push(`/admin/studio/${r.id}`)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
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
            {dot(r.specsVerified)} specs · ◑ {r.approvedAiCount}/4 · {dot(r.copyStatus === "approved")} copy ·{" "}
            {r.targets.map((t) => `${t.state === "live" ? "▪" : "▫"}${t.portal === "wholesale" ? "WS" : "SH"}`).join(" ")}
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
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="cursor-pointer" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }} onClick={() => router.push(`/admin/studio/${r.id}`)}>
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
                <td className="font-mono text-right" style={{ fontSize: 11.5, color: palette.softBlack, padding: "8px 6px" }}>{r.approvedAiCount}/4</td>
                <td className="font-body uppercase" style={{ fontSize: 10, color: r.tier === "hero" ? palette.goldDeep : palette.mutedGreige, padding: "8px 6px" }}>{r.tier}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="font-body py-8 text-center" style={{ fontSize: 12, color: palette.mutedGreige }}>No designs match.</div>}
      </div>

      {/* Batch bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-16 md:bottom-4 inset-x-0 z-40 mx-auto max-w-2xl px-3">
          <div className="flex items-center gap-2 flex-wrap p-3" style={{ background: palette.black, boxShadow: "0 6px 24px rgba(0,0,0,0.35)" }}>
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
                  if (!pre.ok || !pre.items?.length) { flash(pre.error ?? "Nothing awaiting review in the selection"); return; }
                  setConfirm({ kind: "approve", items: pre.items });
                });
              }}
              className="font-body uppercase disabled:opacity-50"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}
            >
              Approve all
            </button>
            <button type="button" disabled title="Publishing arrives in Stage 7" className="font-body uppercase opacity-40" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: "1px solid rgba(214,197,161,0.4)", padding: "8px 10px" }}>Push WS</button>
          </div>
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
                <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>
                  Approve {confirm.items.length} candidate{confirm.items.length === 1 ? "" : "s"}
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
                  onClick={() => { const idsToApprove = confirm.items.map((i) => i.candidateId); setConfirm(null); runBatch(() => approveAllBatch(idsToApprove).then((r) => ({ ok: r.ok, error: r.error })), "Batch approved"); }}
                  className="mt-4 w-full font-body uppercase disabled:opacity-50"
                  style={{ fontSize: 10.5, letterSpacing: "0.18em", background: "#1F6B45", color: "#fff", fontWeight: 600, padding: "12px 0" }}
                >
                  Approve all shown
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

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2 flex items-center gap-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
          <Check size={13} color={palette.gold} /> {toast}
        </div>
      )}
    </div>
  );
}

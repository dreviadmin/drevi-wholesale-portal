"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Search, X, ScanLine, ImageOff, Check, Crown } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { useSort, SortTh, type SortState } from "@/components/sortable";
import { withFrom } from "@/components/BackLink";
import { palette } from "@/lib/palette";
import { useToast } from "@/lib/use-toast";
import { queueTray } from "@/app/admin/sku-generator/labels";
import { MISSING_FIELDS, type MissingKey } from "@/lib/studio/missing";
import { DEFAULT_BOARD_SORT, boardPath, parseBoardQuery } from "@/lib/studio/board-url";
import { BatchProgress, type BatchProgressState } from "@/components/admin/BatchProgress";
import { BADGE_LABEL, type DesignBadge } from "@/lib/studio/state";
import { portalToggleToast } from "@/lib/studio/batch-toast";
import type { BoardRow } from "@/lib/studio/load";
import { setTierBatch, togglePortalBatch, runFashnBatch, approveAllPreflight, approveAllBatch, generateCopyBatch, pushWholesaleBatch, pushShopifyBatch, traySkusForDesigns, setDiscontinuedBatch } from "./actions";
import { changeDesignBuckets, removeStudioBucket } from "./bucket-actions";
import { BatchBucketPicker, BucketPicker, useBuckets } from "./BucketPicker";
import {
  BUCKET_NONE, applyBucketChange, bucketLabel, bucketMarks, bucketSummary, countBuckets, describeBucketChange, filterBuckets,
  inBucketFilter, sameBucketKeys, type BucketChange, type StudioBucket,
} from "@/lib/studio/buckets";
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
// Smaller: discontinuing makes a Shopify call for every design live there.
const RETIRE_CHUNK = 12;
// approveAllBatch's APPROVE_RUN: Use candidates promotes this many per call.
const APPROVE_CHUNK = 200;

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

export function StudioBoard({
  rows: serverRows,
  buckets: serverBuckets,
  fashnOn = false,
  runnerOn = false,
}: {
  rows: BoardRow[];
  buckets: StudioBucket[];
  /** fashnEnabled() on the server — model swap is parked unless FASHN_ENABLED=true. */
  fashnOn?: boolean;
  /** GITHUB_PAT + GITHUB_RUNNER_REPO set on the server — the only worker for scan_drive and batch tryon jobs. */
  runnerOn?: boolean;
}) {
  const router = useRouter();
  // Buckets (0074). A pick shows at once — the row moves between filter chips
  // before the server answers — via a per-design override over the server
  // rows. Entries drop out once a refresh brings the same value back.
  const { buckets, remember, promptAndAdd } = useBuckets(serverBuckets);
  // Each entry is owned by the pick that wrote it (seq). A failed pick only
  // removes entries it still owns — never writes an old value back over a
  // newer pick — and removing the entry lets the server value show through.
  // An entry also drops once the server reports the same value, or once its
  // pick has settled and a later refresh has arrived.
  const [bucketOverride, setBucketOverride] = useState<Map<string, { keys: string[]; seq: number; settled?: boolean }>>(new Map());
  const pickSeq = useRef(0);
  useEffect(() => {
    setBucketOverride((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const r of serverRows) {
        const o = next.get(r.id);
        if (o && (sameBucketKeys(o.keys, r.buckets) || o.settled)) next.delete(r.id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [serverRows]);
  const rows = useMemo(
    () => (bucketOverride.size === 0 ? serverRows : serverRows.map((r) => {
      const o = bucketOverride.get(r.id);
      return o ? { ...r, buckets: o.keys } : r;
    })),
    [serverRows, bucketOverride],
  );
  // Server actions run one at a time, and opening a design discards any that
  // have not been sent yet — so a quick run of picks followed by a tap on a
  // row could lose the last one. Navigation waits for these, and closing the
  // tab asks first.
  const bucketWrites = useRef<Promise<unknown>>(Promise.resolve());
  const pendingWrites = useRef(0);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (pendingWrites.current > 0) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  // MULTI-select and OR'd like Photos and Missing; BUCKET_NONE is "Not set".
  const [bucketFilter, setBucketFilter] = useState<Set<string>>(new Set());
  // While a design's picker is open, the filter and the Buckets sort read the
  // buckets it had when the picker opened. Otherwise the first tick under
  // "Not set" takes the row, and its picker, off the board before a second
  // bucket can be ticked, and under the sort the row moves away from its open
  // panel. Counts stay live. Released when the picker closes.
  // One hold per open picker: a second picker opened from the keyboard must
  // not release the first one's row.
  const [held, setHeld] = useState<ReadonlyMap<string, string[]>>(new Map());
  const keysFor = (r: BoardRow) => held.get(r.id) ?? r.buckets;
  const holdWhileOpen = (r: BoardRow) => (open: boolean) =>
    setHeld((h) => {
      if (open === h.has(r.id)) return h;
      const n = new Map(h);
      if (open) n.set(r.id, r.buckets); else n.delete(r.id);
      return n;
    });
  // Closing a picker can take its row off the board. Focus then goes to the
  // picker of the row that took its place, so a keyboard user keeps going
  // down the list rather than landing back at the top of the page.
  const refocusAt = (index: number) => () => {
    const triggers = [...document.querySelectorAll<HTMLElement>("[data-bucket-trigger]")].filter((el) => el.offsetParent !== null);
    (triggers[Math.min(index, triggers.length - 1)] ?? document.querySelector<HTMLElement>("input[placeholder^='Search base SKU']"))?.focus();
  };
  const [editBuckets, setEditBuckets] = useState(false);
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
  // OR, not AND: the job these serve is a sweep — "show me everything with a
  // gap in any of these" — not "everything missing all of them at once".
  const [missingFilter, setMissingFilter] = useState<Set<MissingKey>>(new Set());
  // Retired products are OUT by default and everything else on this board —
  // counts, filters, select-all — works on the visible set, so switching this
  // on is the only way to touch one (0063).
  const [showDiscontinued, setShowDiscontinued] = useState(false);
  const [query, setQuery] = useState("");
  // Held here rather than inside useSort so the URL can seed it.
  const [sortState, setSortState] = useState<SortState>(DEFAULT_BOARD_SORT);
  // The view is written back to the address only once it has been read from
  // it, or the first render would wipe a deep link before it was applied.
  const [urlRead, setUrlRead] = useState(false);
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

  // Cockpit deep-links land pre-filtered (/admin/studio?state=needs_photos),
  // and Back from a design lands on the list it was opened from: chips,
  // search, sort and Show discontinued (board-url.ts).
  useEffect(() => {
    const v = parseBoardQuery(new URLSearchParams(window.location.search));
    setChip(v.chip);
    setSpecsFilter(v.specs);
    setPhotoCounts(new Set(v.photos));
    setMissingFilter(new Set(v.missing));
    setBucketFilter(new Set(v.buckets));
    setQuery(v.query);
    setSortState(v.sort);
    setShowDiscontinued(v.showDiscontinued);
    setUrlRead(true);
  }, []);

  // Every chip count below is over `live`, not `rows`: a board showing 287
  // designs must not have chips that add up to 300 because retired ones are
  // still being counted behind the scenes.
  const retiredCount = useMemo(() => rows.filter((r) => r.discontinuedAt).length, [rows]);
  const live = useMemo(
    () => (showDiscontinued ? rows : rows.filter((r) => !r.discontinuedAt)),
    [rows, showDiscontinued],
  );

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of live) c.set(r.badge, (c.get(r.badge) ?? 0) + 1);
    return c;
  }, [live]);

  const specsCounts = useMemo(() => {
    const confirmed = live.filter((r) => r.specsVerified).length;
    return { confirmed, awaiting: live.length - confirmed };
  }, [live]);

  // Over every row, not the filtered set — the same rule the state, specs and
  // photo chips already follow, so the number on a chip is an inventory rather
  // than a reflection of whatever else is switched on.
  const missingTotals = useMemo(() => {
    const c = new Map<MissingKey, number>();
    for (const r of live) for (const k of r.missing ?? []) c.set(k, (c.get(k) ?? 0) + 1);
    return c;
  }, [live]);

  // Keyed by bucket, BUCKET_NONE for Not set — over `live`, like every chip.
  // A design in two buckets counts under both.
  const bucketTotals = useMemo(() => countBuckets(live), [live]);
  const bucketChips = useMemo(() => filterBuckets(buckets, bucketTotals, bucketFilter), [buckets, bucketTotals, bucketFilter]);

  const photoCountTotals = useMemo(() => {
    const c = new Array(7).fill(0) as number[];
    for (const r of live) if (r.filledCount >= 0 && r.filledCount <= 6) c[r.filledCount] += 1;
    return c;
  }, [live]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return live.filter((r) => {
      if (chip !== "all" && r.badge !== chip) return false;
      if (specsFilter === "confirmed" && !r.specsVerified) return false;
      if (specsFilter === "awaiting" && r.specsVerified) return false;
      if (photoCounts.size > 0 && !photoCounts.has(r.filledCount)) return false;
      if (missingFilter.size > 0 && !(r.missing ?? []).some((k) => missingFilter.has(k))) return false;
      if (!inBucketFilter(keysFor(r), bucketFilter)) return false;
      if (!q) return true;
      return [r.baseSku, r.color, r.title ?? "", r.category ?? ""].some((v) => v.toUpperCase().includes(q));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keysFor reads only `held`
  }, [live, chip, specsFilter, photoCounts, missingFilter, bucketFilter, held, query]);

  const { sorted, sort, toggle } = useSort(filtered, {
    sku: (r) => `${r.baseSku}-${r.color}`,
    title: (r) => r.title ?? "",
    badge: (r) => r.badgeLabel,
    photos: (r) => r.filledCount,
    tier: (r) => r.tier,
    // Not set sorts last whichever way the column runs.
    bucket: (r) => (keysFor(r).length ? bucketSummary(keysFor(r), buckets) : null),
    // Numeric on purpose: useSort compares strings with localeCompare({numeric:true}),
    // which mis-orders ISO fractional seconds of unequal length.
    added: (r) => (r.createdAt ? Date.parse(r.createdAt) : null),
  }, undefined, { sort: sortState, onSort: setSortState });

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
  // Bulk retire / restore. One routine, because the only difference is the
  // direction and the words — duplicating it would be two places to fix the
  // chunking, the Stop check and the tally.
  function runRetire(discontinued: boolean, targetIds: string[]) {
    const label = discontinued ? "Discontinuing" : "Restoring";
    startTransition(async () => {
      startRun();
      let done = 0, skipped = 0, failed = 0, archived = 0, unarchived = 0, stuck = 0, inCatalog = 0, seen = 0;
      let firstError: string | undefined;
      runProgress(label, 0, targetIds.length, discontinued ? "each one on Shopify is archived" : "archived Shopify products go back to draft");
      for (let i = 0; i < targetIds.length; i += RETIRE_CHUNK) {
        if (stopRef.current) {
          endProgress(label, targetIds.length, `stopped at ${seen} of ${targetIds.length} · ${done} done`, seen);
          flash(`Stopped. ${done} done · ${targetIds.length - seen} not started`);
          router.refresh();
          return;
        }
        const chunk = targetIds.slice(i, i + RETIRE_CHUNK);
        const r = await setDiscontinuedBatch(chunk, discontinued);
        if (!r.ok) {
          flash(r.error ?? "Failed");
          endProgress(label, targetIds.length, `stopped at ${seen} of ${targetIds.length} — ${r.error ?? "failed"}`, seen);
          return;
        }
        done += r.done ?? 0; skipped += r.skipped ?? 0; failed += r.failed ?? 0;
        archived += r.shopifyArchived ?? 0; unarchived += r.shopifyUnarchived ?? 0; stuck += r.shopifyStuck ?? 0;
        inCatalog += r.catalogStuck ?? 0;
        if (!firstError && r.firstError) firstError = r.firstError;
        seen += chunk.length;
        const tally = `${done} done${skipped ? ` · ${skipped} already` : ""}${failed ? ` · ${failed} failed` : ""}`;
        runProgress(label, seen, targetIds.length, tally);
        flash(`${label} ${seen}/${targetIds.length} · ${tally}`);
      }
      // A product left outside the archive is the one outcome worth leading with.
      // One still in the buyer catalog is the other: its card keeps Unpublish
      // wholesale for exactly that.
      const tail = (stuck
        ? ` · ${stuck} NOT ARCHIVED IN SHOPIFY${firstError ? ` — ${firstError}` : ""}`
        : archived ? ` · ${archived} archived in Shopify`
        : unarchived ? ` · ${unarchived} back to draft in Shopify` : "") +
        (inCatalog ? ` · ${inCatalog} STILL IN THE BUYER CATALOG — use Unpublish wholesale` : "");
      // "3 failed" alone leaves nothing to act on, so the reason sits beside that
      // count: after the Shopify tally it would read as a verdict on the whole run.
      const reason = !stuck && firstError ? ` (${firstError})` : "";
      endProgress(label, targetIds.length, `${done} done${skipped ? ` · ${skipped} already` : ""}${failed ? ` · ${failed} failed${reason}` : ""}${tail}`);
      flash(`${discontinued ? "Discontinued" : "Restored"} ${done}${skipped ? ` · ${skipped} already` : ""}${failed ? ` · ${failed} failed${reason}` : ""}${tail}`);
      setSelected(new Set());
      router.refresh();
    });
  }

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

  // `done` is the toast on success: fixed text, or built from the result when
  // the action reports a count (SH on / SH off).
  function runBatch<R extends { ok: boolean; error?: string }>(fn: () => Promise<R>, done: string | ((res: R) => string)) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) { flash(typeof done === "function" ? done(res) : done); setSelected(new Set()); router.refresh(); }
      else flash(res.error ?? "Failed");
    });
  }

  const ids = [...selected];
  // A selection can span both states once retired products are shown, so the
  // two buttons act on their own half rather than one of them half-failing.
  const retiredSelected = useMemo(() => rows.filter((r) => selected.has(r.id) && r.discontinuedAt).map((r) => r.id), [rows, selected]);
  const liveSelected = useMemo(() => rows.filter((r) => selected.has(r.id) && !r.discontinuedAt).map((r) => r.id), [rows, selected]);
  const dot = (on: boolean) => (on ? "✓" : "○");

  // Change buckets on one design (its picker) or many (the batch picker). Not
  // a transition: classifying is rapid-fire down a list, and a transition would
  // grey out every other control on the board while each one saves.
  // Resolves to the error text when the save failed, so an open picker can
  // show it: on a phone its sheet covers the toast.
  async function changeBuckets(targetIds: string[], change: BucketChange, fromBatch = false, labels: Map<string, string> = new Map()): Promise<string | null> {
    if (targetIds.length === 0) return null;
    const seq = ++pickSeq.current;
    // Built on the newest pending value, not this render's rows: a tick made
    // while "Add custom…" waited on the network must not be written over.
    const before = new Map(serverRows.filter((r) => targetIds.includes(r.id)).map((r) => [r.id, r.buckets]));
    setBucketOverride((prev) => {
      const n = new Map(prev);
      for (const id of targetIds) n.set(id, { keys: applyBucketChange(prev.get(id)?.keys ?? before.get(id) ?? [], change), seq });
      return n;
    });
    const what = describeBucketChange(change, (k) => labels.get(k) ?? bucketLabel(k, buckets));
    pendingWrites.current++;
    const write = changeDesignBuckets(targetIds, change).catch(() => undefined);
    bucketWrites.current = bucketWrites.current.then(() => write);
    let res: Awaited<typeof write>;
    try { res = await write; } finally { pendingWrites.current--; }
    if (!res?.ok) {
      setBucketOverride((prev) => {
        const n = new Map(prev);
        for (const id of targetIds) if (n.get(id)?.seq === seq) n.delete(id);
        return n;
      });
      const error = res?.error ?? "Could not save the buckets — check the connection";
      flash(error);
      router.refresh();
      return error;
    }
    setBucketOverride((prev) => {
      const n = new Map(prev);
      for (const id of targetIds) { const o = n.get(id); if (o?.seq === seq) n.set(id, { ...o, settled: true }); }
      return n;
    });
    if (fromBatch) setSelected(new Set());
    const one = targetIds.length === 1 ? rows.find((r) => r.id === targetIds[0]) : null;
    flash(one ? `${one.baseSku} · ${one.color}: ${what}` : `${res.updated ?? targetIds.length} designs: ${what}`);
    return null;
  }
  // "+ Add custom…" in a design's picker: create (or reuse) the bucket, then
  // put the design in it.
  async function addBucketAndPick(id: string): Promise<string | null> {
    const r = await promptAndAdd();
    if (!r) return null;
    if (!r.bucket) { const error = r.error ?? "Could not add the bucket"; flash(error); return error; }
    if (r.existed) flash(`"${r.bucket.label}" already exists — using it`);
    return changeBuckets([id], { add: [r.bucket.key] }, false, new Map([[r.bucket.key, r.bucket.label]]));
  }
  // The same from the batch picker, which ticks it and saves on Apply.
  async function createForBatch(): Promise<StudioBucket | null> {
    const r = await promptAndAdd();
    if (!r) return null;
    if (!r.bucket) { flash(r.error ?? "Could not add the bucket"); return null; }
    if (r.existed) flash(`"${r.bucket.label}" already exists — using it`);
    return r.bucket;
  }
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const batchMarks = useMemo(
    () => bucketMarks(selectedRows, new Set([...buckets.map((b) => b.key), ...selectedRows.flatMap((r) => r.buckets)])),
    [selectedRows, buckets],
  );
  async function retireBucket(b: StudioBucket) {
    const n = bucketTotals.get(b.key) ?? 0;
    if (!window.confirm(`Remove "${b.label}" from the picker?${n === 1 ? " The 1 design in it keeps it until you take it off." : n > 1 ? ` The ${n} designs in it keep it until you take it off them.` : ""}`)) return;
    const res = await removeStudioBucket(b.key);
    if (!res.ok) { flash(res.error ?? "Could not remove it"); return; }
    remember({ ...b, active: false });
    flash(`Removed "${b.label}"`);
  }
  // Carry the whole view so the workbench's back link lands on the same
  // list — Grishma works down her filtered set one design at a time.
  const boardHref = boardPath({
    chip, specs: specsFilter, photos: photoCounts, missing: missingFilter, buckets: bucketFilter,
    query, sort: sortState, showDiscontinued,
  });
  // And keep the board's own address in step (replace, not push, so a filter
  // tap adds no Back step): the browser's back, or a swipe on a phone, then
  // returns to this view too.
  useEffect(() => {
    if (!urlRead || window.location.pathname + window.location.search === boardHref) return;
    window.history.replaceState(null, "", boardHref);
  }, [boardHref, urlRead]);
  const openRow = async (id: string) => {
    if (pendingWrites.current > 0) { flash("Saving buckets…"); await bucketWrites.current; }
    router.push(withFrom(`/admin/studio/${id}`, boardHref));
  };

  const rowCard = (r: BoardRow) => (
    // Retired designs read as retired on a phone too, as the laptop row does.
    <div key={r.id} className="p-3" style={{ background: r.discontinuedAt ? "rgba(156,58,49,0.05)" : palette.ivory, border: "1px solid rgba(26,26,26,0.08)", opacity: r.discontinuedAt ? 0.6 : 1 }}>
    <div className="flex items-center gap-3">
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
          {/* Wraps instead of truncating: at 375px an ellipsis ate the colour,
              so two colours of one base SKU looked the same. "· COLOR" (and
              the hero crown) stay together, so the line breaks before them. */}
          <span className="font-mono block" style={{ fontSize: 12, fontWeight: 700, color: palette.black, overflowWrap: "anywhere" }}>
            {r.baseSku}{" "}
            <span className="whitespace-nowrap">· {r.color}{r.tier === "hero" && <>{" "}<Crown size={11} className="inline" color={palette.goldDeep} /></>}</span>
          </span>
          {/* Own line, so the tag never crowds the SKU. */}
          {r.discontinuedAt && (
            <span className="font-body uppercase inline-block my-0.5" style={{ fontSize: 10, letterSpacing: "0.12em", color: "#9C3A31", border: "1px solid #9C3A31", padding: "1px 5px" }}>Discontinued</span>
          )}
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
      {/* Outside the row's button: a control inside a button is invalid HTML
          and the tap would open the workbench instead. */}
      <div className="flex items-center gap-2 mt-2 min-w-0" style={{ paddingLeft: 26 }}>
        <span className="font-body uppercase flex-none" style={{ fontSize: 8, letterSpacing: "0.14em", color: palette.mutedGreige }}>Buckets</span>
        <BucketPicker
          value={r.buckets}
          buckets={buckets}
          ariaLabel={`Buckets for ${r.baseSku} · ${r.color}`}
          onToggle={(k, on) => changeBuckets([r.id], on ? { add: [k] } : { remove: [k] })}
          onClear={() => changeBuckets([r.id], { clear: true })}
          onAdd={() => addBucketAndPick(r.id)}
          onOpenChange={holdWhileOpen(r)}
          onFocusLost={refocusAt(sorted.findIndex((x) => x.id === r.id))}
        />
      </div>
    </div>
  );

  return (
    <div className="px-4 md:px-8 py-6 max-w-5xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Studio</h1>
          <p className="font-body mt-1" style={{ fontSize: 11.5, color: palette.mutedGreige }}>
            {live.length} designs · photos, copy and publishing converge here.
          </p>
        </div>
        {/* A scan_drive job is run ONLY by the hosted runner (ANSH-04, parked):
            /api/pipeline/run has no engine for it. Without the runner the button
            said "Drive backfill queued", nothing was ingested, and the row timed
            out 30 minutes later. So, like "FASHN parked", it stays drawn,
            disabled and saying why until the runner is configured; the queue
            code is untouched. Per-design Sync Drive in the Workbench works. */}
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            disabled={pending || !runnerOn}
            title={runnerOn ? undefined : "No hosted runner is configured, so nothing would run this job"}
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
          {!runnerOn && (
            <span className="font-body text-right" style={{ fontSize: 10, color: palette.mutedGreige, maxWidth: 220 }}>
              Parked — no hosted runner. Use Sync Drive on a design’s Workbench.
            </span>
          )}
        </div>
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
          // live, like every other chip — rows would count retired designs the
          // list is hiding ("All · 300" over 287 cards).
          const n = c === "all" ? live.length : counts.get(c) ?? 0;
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

      {/* Discontinued (0063). Only appears once something IS retired — a chip
          reading "Discontinued · 0" is a permanent reminder of a state the
          board is not in. Switching it on brings them back into every count
          and filter on the page, so a retired product can be found, looked at
          and restored. */}
      {retiredCount > 0 && (
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            aria-pressed={showDiscontinued}
            onClick={() => setShowDiscontinued((v) => !v)}
            className="font-body uppercase whitespace-nowrap"
            style={{
              fontSize: 9.5, letterSpacing: "0.1em", padding: "7px 10px",
              background: showDiscontinued ? palette.black : palette.ivory,
              color: showDiscontinued ? palette.ivory : palette.softBlack,
              border: "1px solid rgba(26,26,26,0.12)",
            }}
          >
            {showDiscontinued ? "Hide" : "Show"} discontinued · {retiredCount}
          </button>
          {showDiscontinued && (
            <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
              Retired products are in the list and marked.
            </span>
          )}
        </div>
      )}

      {/* Missing specs — MULTI-select and OR'd, because the job is a sweep.
          Origin leads the row: it picks the Shopify size ladder, and without
          it a design is listed in only the sizes physically in stock — which
          is how 21 of 103 products reached the store in one size on 21 Sep.
          A chip at zero is dropped rather than shown greyed: unlike the photo
          counts, which are a fixed 0..6 scale, this row has no natural order
          to preserve and a wall of zeroes would bury the gaps that exist. */}
      {missingTotals.size > 0 && (
        <div className="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar">
          <span className="font-body uppercase whitespace-nowrap" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Missing</span>
          {MISSING_FIELDS.filter((f) => (missingTotals.get(f.key) ?? 0) > 0).map((f) => {
            const n = missingTotals.get(f.key) ?? 0;
            const active = missingFilter.has(f.key);
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setMissingFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(f.key)) next.delete(f.key); else next.add(f.key);
                    return next;
                  })
                }
                className="font-body uppercase whitespace-nowrap"
                style={{
                  fontSize: 9.5, letterSpacing: "0.1em", padding: "7px 10px",
                  background: active ? palette.black : palette.ivory,
                  color: active ? palette.ivory : palette.softBlack,
                  border: "1px solid rgba(26,26,26,0.12)",
                }}
              >
                {f.label} · {n}
              </button>
            );
          })}
          {missingFilter.size > 0 && (
            <button type="button" onClick={() => setMissingFilter(new Set())} aria-label="Clear missing filter" className="font-body uppercase whitespace-nowrap" style={{ fontSize: 9, letterSpacing: "0.1em", padding: "7px 8px", color: palette.mutedGreige, background: "transparent", border: "none" }}>
              Clear
            </button>
          )}
        </div>
      )}

      {/* Buckets (0074) — staff work queues. MULTI-select and OR'd like the
          rows above: a design shows if it is in any picked bucket, and a design
          in two buckets counts under both. Every active bucket keeps its chip
          at zero, so a custom bucket appears here the moment it is added;
          "Not set" (in no bucket) is last. */}
      <div className="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar">
        <span className="font-body uppercase whitespace-nowrap" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Buckets</span>
        {[...bucketChips.map((b) => ({ key: b.key, label: b.active ? b.label : `${b.label} (removed)` })), { key: BUCKET_NONE, label: "Not set" }].map((c) => {
          const n = bucketTotals.get(c.key) ?? 0;
          const active = bucketFilter.has(c.key);
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={active}
              onClick={() =>
                setBucketFilter((prev) => {
                  const next = new Set(prev);
                  if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
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
              {c.label} · {n}
            </button>
          );
        })}
        {bucketFilter.size > 0 && (
          <button type="button" onClick={() => setBucketFilter(new Set())} aria-label="Clear bucket filter" className="font-body uppercase whitespace-nowrap" style={{ fontSize: 9, letterSpacing: "0.1em", padding: "7px 8px", color: palette.mutedGreige, background: "transparent", border: "none" }}>
            Clear
          </button>
        )}
        <button type="button" onClick={() => setEditBuckets((v) => !v)} aria-expanded={editBuckets} className="font-body uppercase whitespace-nowrap" style={{ fontSize: 9, letterSpacing: "0.1em", padding: "7px 8px", color: palette.goldDeep, background: "transparent", border: "none" }}>
          {editBuckets ? "Done" : "Edit list"}
        </button>
      </div>
      {editBuckets && (
        <div className="mt-2 p-3 flex flex-col gap-2" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
          <div className="font-body" style={{ fontSize: 11, color: palette.softBlack, lineHeight: 1.5 }}>
            Add a bucket from any bucket picker (&ldquo;Add custom…&rdquo;). Removing one takes it out of the picker; designs already in it keep it. The four standard buckets stay.
          </div>
          {buckets.filter((b) => !b.preset && b.active).length === 0 ? (
            <div className="font-body" style={{ fontSize: 11, color: palette.mutedGreige }}>No custom buckets yet.</div>
          ) : (
            buckets.filter((b) => !b.preset && b.active).map((b) => (
              <div key={b.key} className="flex items-center justify-between gap-3">
                <span className="font-body" style={{ fontSize: 12, color: palette.black }}>
                  {b.label} <span style={{ color: palette.mutedGreige }}>· {bucketTotals.get(b.key) ?? 0}</span>
                </span>
                <button type="button" onClick={() => retireBucket(b)} aria-label={`Remove bucket ${b.label}`} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.1em", padding: "5px 9px", color: "#9C3A31", border: "1px solid #9C3A31", background: "transparent" }}>
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      )}

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
              <SortTh label="Buckets" k="bucket" sort={sort} onToggle={toggle} />
              <SortTh label="Added" k="added" sort={sort} onToggle={toggle} right defaultDir="desc" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer"
                style={{
                  borderBottom: "1px solid rgba(26,26,26,0.06)",
                  // Dimmed and struck through, not hidden behind a badge alone:
                  // when the toggle is on these sit among live products and the
                  // difference has to read at a glance.
                  opacity: r.discontinuedAt ? 0.55 : 1,
                  background: r.discontinuedAt ? "rgba(156,58,49,0.05)" : undefined,
                }}
                title={r.discontinuedAt ? `Discontinued ${new Date(r.discontinuedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}${r.discontinuedBy ? ` by ${r.discontinuedBy}` : ""}${r.discontinuedNote ? ` — ${r.discontinuedNote}` : ""}` : undefined}
                onClick={() => openRow(r.id)}
              >
                <td onClick={(e) => e.stopPropagation()} style={{ padding: "8px 4px" }}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} aria-label={`Select ${r.baseSku}`} style={{ accentColor: palette.goldDeep }} />
                </td>
                <td style={{ padding: "8px 4px" }}>
                  {r.thumb ? <Image src={r.thumb} alt="" width={36} height={45} className="object-cover" unoptimized /> : <span className="inline-flex items-center justify-center" style={{ width: 36, height: 45, background: palette.ivoryDeep }}><ImageOff size={12} color={palette.mutedGreige} /></span>}
                </td>
                <td className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: palette.black, padding: "8px 6px" }}>
                  {r.baseSku} · {r.color} {r.tier === "hero" && <Crown size={11} className="inline" color={palette.goldDeep} />}
                  {r.discontinuedAt && (
                    <span className="font-body uppercase" style={{ marginLeft: 6, fontSize: 8, letterSpacing: "0.12em", color: "#9C3A31", border: "1px solid #9C3A31", padding: "2px 5px" }}>Discontinued</span>
                  )}
                </td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "8px 6px", maxWidth: 260 }}>{r.title ?? "—"}</td>
                <td style={{ padding: "8px 6px" }}>
                  <span className="font-body uppercase px-2 py-1" style={{ fontSize: 8.5, letterSpacing: "0.1em", fontWeight: 600, background: BADGE_STYLE[r.badge].bg, color: BADGE_STYLE[r.badge].fg }}>{r.badgeLabel}</span>
                </td>
                <td className="font-mono text-right" style={{ fontSize: 11.5, color: palette.softBlack, padding: "8px 6px" }}>{r.filledCount}/6</td>
                <td className="font-body uppercase" style={{ fontSize: 10, color: r.tier === "hero" ? palette.goldDeep : palette.mutedGreige, padding: "8px 6px" }}>{r.tier}</td>
                <td onClick={(e) => e.stopPropagation()} style={{ padding: "8px 6px", maxWidth: 190 }}>
                  <BucketPicker
                    value={r.buckets}
                    buckets={buckets}
                    ariaLabel={`Buckets for ${r.baseSku} · ${r.color}`}
                    onToggle={(k, on) => changeBuckets([r.id], on ? { add: [k] } : { remove: [k] })}
                    onClear={() => changeBuckets([r.id], { clear: true })}
                    onAdd={() => addBucketAndPick(r.id)}
                    onOpenChange={holdWhileOpen(r)}
                    onFocusLost={refocusAt(sorted.findIndex((x) => x.id === r.id))}
                  />
                </td>
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
            <BatchBucketPicker
              count={selected.size}
              marks={batchMarks}
              buckets={buckets}
              disabled={pending}
              onApply={(change) => { void changeBuckets(ids, change, true); }}
              onCreate={createForBatch}
            />
            <button type="button" disabled={pending} onClick={() => runBatch(() => setTierBatch(ids, "hero"), "Tier set to hero")} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.black, background: palette.gold, padding: "8px 10px" }}>Set hero</button>
            <button type="button" disabled={pending} onClick={() => runBatch(() => setTierBatch(ids, "standard"), "Tier set to standard")} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}>Set standard</button>
            <button type="button" disabled={pending} onClick={() => runBatch(() => togglePortalBatch(ids, "shopify", false), (r) => portalToggleToast("shopify", false, r.changed ?? 0, r.unchanged))} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}>SH off</button>
            <button type="button" disabled={pending} onClick={() => runBatch(() => togglePortalBatch(ids, "shopify", true), (r) => portalToggleToast("shopify", true, r.changed ?? 0, r.unchanged))} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}>SH on</button>
            {/* Model swap is PARKED (FASHN_ENABLED, 19 Sep) and 0053 moved
                every angle off the fashn engine, so while parked this gold
                button could only ever answer "No pending AI angles". It stays
                drawn, disabled and saying why, rather than silently vanishing;
                the engine code is untouched for the day the flag comes back.
                Its tryon jobs are also run ONLY by the hosted runner (nothing
                calls /api/pipeline/run for them), so with the flag on but no
                runner it would take the credit confirm and queue jobs that
                time out — disabled and saying so, like Backfill from Drive. */}
            <button
              type="button"
              disabled={pending || !fashnOn || !runnerOn}
              title={!fashnOn ? "Model swap is parked — set FASHN_ENABLED=true to bring it back" : !runnerOn ? "No hosted runner is configured, so nothing would run these jobs" : undefined}
              onClick={() => {
                startTransition(async () => {
                  const pre = await runFashnBatch(ids, true);
                  if (!pre.ok || !pre.jobs) { flash(pre.error ?? "No pending AI angles in the selection"); return; }
                  setConfirm({ kind: "fashn", jobs: pre.jobs, credits: pre.credits ?? 0 });
                });
              }}
              className="font-body uppercase disabled:opacity-50"
              style={
                fashnOn && runnerOn
                  ? { fontSize: 9, letterSpacing: "0.1em", color: palette.black, background: palette.gold, padding: "8px 10px" }
                  : { fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }
              }
            >
              {!fashnOn ? "FASHN parked" : !runnerOn ? "FASHN · no runner" : "Run FASHN"}
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
                if (!window.confirm(`Generate copy for ${liveSelected.length} design(s)? One vision call each; unverified specs are skipped. Runs in batches of ${COPY_CHUNK} — leave this tab open.`)) return;
                startTransition(async () => {
                  // The ACTION caps at 10 because each design is one Opus
                  // vision call run sequentially inside a Vercel function with
                  // a 60s ceiling — ten is about what fits. Selecting 101 used
                  // to silently do ten and drop the rest. The cap stays where
                  // it belongs, on the server; the button now feeds it in
                  // chunks so one click means one click. (Ansh, 21 Sep.)
                  let gen = 0, skip = 0, fail = 0, done = 0;
                  startRun();
                  // Shadows the outer `ids`, as the push handlers do: the
                  // confirm counted liveSelected, so the loop must too, or a
                  // mixed selection spends Opus calls on retired products.
                  const ids = liveSelected;
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
                if (!window.confirm(`Push ${liveSelected.length} design(s) to wholesale? Gate-blocked designs are skipped and reported.`)) return;
                startTransition(async () => {
                  let pushed = 0, blocked = 0, failed = 0, done = 0;
                  startRun();
                  // Shadows the outer `ids` for this whole handler, so every
                  // count, chunk and message below moves with it. A retired
                  // design is gate-blocked anyway, but sending it would fill
                  // the tally with blocks and invite someone to "fix" the
                  // block by restoring the product.
                  const ids = liveSelected;
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
                if (!window.confirm(`Push ${liveSelected.length} design(s) to Shopify? New products are created as DRAFT; gate-blocked designs are skipped and reported.`)) return;
                startTransition(async () => {
                  let pushed = 0, blocked = 0, failed = 0, done = 0, firstError = "";
                  startRun();
                  const ids = liveSelected;
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
            {/* Print tags (Ansh, 22 Sep). Reuses the print tray the SKU
                generator already reads on mount and that Log delivery already
                stages into — a tag is per SIZE, and the sizes are the one
                thing a (base, colour) board row cannot answer for itself, so
                the server resolves them from sku_registry. "merge" so a tray
                someone was already building is added to, not thrown away. */}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  const res = await traySkusForDesigns(ids);
                  if (!res.ok || !res.skus?.length) {
                    flash(res.error ?? "No minted SKUs in the selection");
                    return;
                  }
                  if (!queueTray(res.skus, "merge")) { flash("Could not write the print tray"); return; }
                  const miss = res.missing?.length
                    ? ` · no SKUs for ${res.missing.slice(0, 3).join(", ")}${res.missing.length > 3 ? ` +${res.missing.length - 3}` : ""}`
                    : "";
                  flash(`${res.skus.length} tag(s) queued from ${res.groups} design(s)${miss} — opening the print tray`);
                  // price=1: tags from Studio are shop-floor tags, so the tray
                  // opens on "With price" and fetches the vendor line and MRP
                  // itself (Ansh, 28 Sep: they came out blank).
                  router.push("/admin/sku-generator?tab=print&price=1");
                });
              }}
              className="font-body uppercase disabled:opacity-50"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}
              title="Stages one label per size SKU on this device's print tray and opens it"
            >
              Print tags
            </button>

            {/* Retire / restore in bulk (Ansh, 23 Sep). Separated from the
                push buttons by a rule and coloured against them: everything to
                the left puts products OUT, these two take them off the board
                and off the storefront. Restore only appears when the selection
                actually holds retired products, which it only can while
                "Show discontinued" is on. */}
            <span style={{ width: 1, alignSelf: "stretch", background: "rgba(255,255,255,0.18)", margin: "0 2px" }} />
            {retiredSelected.length > 0 && (
              <button
                type="button"
                disabled={pending}
                onClick={() => runRetire(false, retiredSelected)}
                className="font-body uppercase disabled:opacity-50"
                style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.ivory, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}
              >
                Restore {retiredSelected.length}
              </button>
            )}
            {liveSelected.length > 0 && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  // Same rule as setDiscontinued: a product existing, not the mirrored state.
                  const onShopify = liveSelected.filter((id) =>
                    rows.find((x) => x.id === id)?.targets.find((tg) => tg.portal === "shopify")?.hasProduct,
                  ).length;
                  if (!window.confirm(
                    `Discontinue ${liveSelected.length} product(s)?\n\n` +
                    `They leave this board, come out of the buyer catalog, and ${onShopify} of them will be archived in Shopify.\n\n` +
                    `They stay sellable at the counter and every past order keeps working. "Show discontinued" brings them back, and each one can be restored.`,
                  )) return;
                  runRetire(true, liveSelected);
                }}
                className="font-body uppercase disabled:opacity-50"
                style={{ fontSize: 9, letterSpacing: "0.1em", color: "#E08A80", border: "1px solid #E08A80", padding: "8px 10px" }}
              >
                Discontinue {liveSelected.length}
              </button>
            )}
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
                      {/* Lazy: the sheet now lists every candidate of a big
                          selection, and an eager grid fired one photo request
                          per candidate the moment it opened. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/drive-photo?id=${encodeURIComponent(it.fileRef)}&s=200`} alt={it.label} loading="lazy" decoding="async" style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover", background: palette.ivoryDeep }} />
                      <div className="font-mono truncate" style={{ fontSize: 7, color: palette.mutedGreige }}>{it.label}</div>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const idsToApprove = confirm.items.map((i) => i.candidateId);
                    setConfirm(null);
                    // "Use all shown" means every one shown: the action takes
                    // APPROVE_CHUNK a call, so it is fed in runs, as the copy
                    // and push batches are.
                    runBatch(async () => {
                      let approved = 0;
                      for (let i = 0; i < idsToApprove.length; i += APPROVE_CHUNK) {
                        const r = await approveAllBatch(idsToApprove.slice(i, i + APPROVE_CHUNK));
                        if (!r.ok) {
                          if (approved > 0) router.refresh();
                          return { ok: false, error: approved > 0 ? `${approved} set as production, then: ${r.error ?? "failed"}` : r.error };
                        }
                        approved += r.approved ?? 0;
                      }
                      return { ok: true };
                    }, "Candidates set as production");
                  }}
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

"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Search, X, ScanLine, CheckSquare, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { bulkSetOrderStatus } from "./actions";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import type { OrderStatus, OrderSource } from "@/lib/types";

export interface OrderRowDTO {
  id: string;
  order_number: string;
  business: string;
  phone: string | null;
  total: number;
  advance: number;
  balance: number;
  status: OrderStatus;
  source: OrderSource;
  submitted_at: string;
  itemsText: string; // lowercased "SKU title" of every line, for search + scan
}

const STATUSES: OrderStatus[] = ["submitted", "confirmed", "packed", "out_for_delivery", "delivered", "fulfilled", "cancelled"];
const STATUS_LABEL: Record<OrderStatus, string> = {
  submitted: "Submitted", confirmed: "Confirmed", packed: "Packed",
  out_for_delivery: "Out for delivery", delivered: "Delivered",
  fulfilled: "Fulfilled", cancelled: "Cancelled",
};
// UX sprint — bulk stage changes from the list. Each target names the stage
// and which current statuses it applies to; ineligible selections are skipped
// server-side too.
const BULK_TARGETS: { status: OrderStatus; label: string; from: OrderStatus[] }[] = [
  { status: "confirmed", label: "Confirm", from: ["submitted"] },
  { status: "packed", label: "Mark packed", from: ["confirmed"] },
  { status: "delivered", label: "Mark delivered", from: ["confirmed", "packed", "out_for_delivery"] },
];
const SOURCES: OrderSource[] = ["portal_self_service", "exhibition", "in_store"];
const SOURCE_LABEL: Record<OrderSource, string> = { portal_self_service: "Portal", exhibition: "Exhibition", in_store: "In-store" };

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
// IST day string — "Today" must flip at India midnight, not UTC's.
function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

const ACCESSORS: Record<string, SortAccessor<OrderRowDTO>> = {
  order: (r) => r.order_number,
  business: (r) => r.business,
  source: (r) => SOURCE_LABEL[r.source],
  status: (r) => r.status,
  total: (r) => r.total,
  advance: (r) => r.advance,
  balance: (r) => r.balance,
  date: (r) => r.submitted_at,
};

export function OrdersTable({ rows }: { rows: OrderRowDTO[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3200); };
  const [status, setStatus] = useState<Set<OrderStatus>>(new Set());
  const [source, setSource] = useState<Set<OrderSource>>(new Set());
  const [range, setRange] = useState<"today" | "7d" | "all">("all");
  const [from, setFrom] = useState("");
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const todayIst = istDay(new Date().toISOString());
    const cutoff7 = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return rows.filter((r) => {
      if (status.size && !status.has(r.status)) return false;
      if (source.size && !source.has(r.source)) return false;
      if (range === "today" && istDay(r.submitted_at) !== todayIst) return false;
      if (range === "7d" && new Date(r.submitted_at).getTime() < cutoff7) return false;
      if (from && r.submitted_at < from) return false;
      if (!q) return true;
      return (
        r.order_number.toLowerCase().includes(q) ||
        r.business.toLowerCase().includes(q) ||
        (r.phone ?? "").toLowerCase().includes(q) ||
        r.itemsText.includes(q)
      );
    });
  }, [rows, status, source, range, from, query]);

  const { sorted, sort, toggle: toggleSort } = useSort(filtered, ACCESSORS, { key: "date", dir: "desc" });

  // Sum of what's on screen — filter to "today" and this is the day's total.
  const totals = useMemo(
    () => filtered.reduce(
      (t, r) => (r.status === "cancelled" ? t : { total: t.total + r.total, balance: t.balance + r.balance }),
      { total: 0, balance: 0 },
    ),
    [filtered],
  );

  // Golden rule: the search has a scan. Scanning a garment tag filters the
  // list to every order containing that SKU.
  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty scan" };
    const hits = rows.filter((r) => r.itemsText.includes(sku.toLowerCase())).length;
    setScanning(false);
    setQuery(sku);
    return hits > 0
      ? { ok: true, message: `${sku} — in ${hits} order${hits > 1 ? "s" : ""}` }
      : { ok: false, message: `${sku} — no orders contain it` };
  }

  function toggle<T>(set: Set<T>, v: T, setter: (s: Set<T>) => void) {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setter(n);
  }
  function toggleRow(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  const allVisibleSelected = sorted.length > 0 && sorted.every((r) => selected.has(r.id));
  function toggleAllVisible() {
    setSelected(allVisibleSelected ? new Set() : new Set(sorted.map((r) => r.id)));
  }
  const selectedRows = rows.filter((r) => selected.has(r.id));

  function runBulk(target: (typeof BULK_TARGETS)[number]) {
    const eligible = selectedRows.filter((r) => target.from.includes(r.status));
    if (eligible.length === 0) { flash(`Nothing selected can be ${target.label.toLowerCase()}ed`); return; }
    const label = `${target.label} ${eligible.length} order${eligible.length === 1 ? "" : "s"}`;
    if (!window.confirm(`${label}?${target.status === "confirmed" ? " Stock leaves the shelf on confirm." : ""}`)) return;
    startTransition(async () => {
      const res = await bulkSetOrderStatus(eligible.map((r) => r.id), target.status);
      if (!res.ok) { flash(res.error ?? "Failed"); return; }
      flash(`${res.done} done${res.skipped.length ? ` · ${res.skipped.length} skipped` : ""}`);
      setSelected(new Set());
      router.refresh();
    });
  }

  const chip = (active: boolean) => ({ fontSize: 9, letterSpacing: "0.14em", padding: "5px 10px", color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.18)" });

  return (
    <div className="px-4 md:px-8 py-6">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Orders</h1>

      {/* Search + scan */}
      <div className="mt-4 flex items-center gap-2 max-w-md" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px" }}>
        <Search size={15} color={palette.mutedGreige} strokeWidth={1.7} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search order no., buyer, phone or SKU"
          className="font-body bg-transparent outline-none w-full"
          style={{ fontSize: 12.5, color: palette.black }}
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
            <X size={14} color={palette.mutedGreige} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setScanning(true)}
          aria-label="Scan a tag to find its orders"
          className="flex items-center gap-1.5 font-body uppercase flex-shrink-0"
          style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}
        >
          <ScanLine size={13} strokeWidth={1.7} /> Scan
        </button>
      </div>

      {/* Filters */}
      <div className="mt-3 flex gap-1.5 flex-wrap items-center">
        {(["today", "7d", "all"] as const).map((r) => (
          <button key={r} type="button" onClick={() => setRange(r)} className="font-body uppercase" style={{ ...chip(range === r), background: range === r ? palette.goldDeep : "transparent", border: range === r ? "none" : "1px solid rgba(26,26,26,0.18)" }}>
            {r === "today" ? "Today" : r === "7d" ? "7 Days" : "All"}
          </button>
        ))}
        <span style={{ width: 1, background: "rgba(26,26,26,0.15)", margin: "0 4px", alignSelf: "stretch" }} />
        {STATUSES.map((s) => <button key={s} type="button" onClick={() => toggle(status, s, setStatus)} className="font-body uppercase" style={chip(status.has(s))}>{STATUS_LABEL[s]}</button>)}
        <span style={{ width: 1, background: "rgba(26,26,26,0.15)", margin: "0 4px", alignSelf: "stretch" }} />
        {SOURCES.map((s) => <button key={s} type="button" onClick={() => toggle(source, s, setSource)} className="font-body uppercase" style={chip(source.has(s))}>{SOURCE_LABEL[s]}</button>)}
        <label className="flex items-center gap-1.5 ml-2 font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "4px 6px", fontSize: 11 }} />
        </label>
      </div>

      {/* On-screen totals */}
      <div className="mt-3 font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>
        {filtered.length} order{filtered.length === 1 ? "" : "s"} · <b>{formatINR(totals.total)}</b>
        {totals.balance > 0 && <span style={{ color: palette.crimsonText }}> · balance due {formatINR(totals.balance)}</span>}
      </div>

      {selected.size > 0 && (
        <div className="mt-3 flex items-center gap-2 flex-wrap p-2.5" style={{ background: palette.black }}>
          <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.16em", color: palette.ivory }}>
            {selected.size} selected
          </span>
          {BULK_TARGETS.map((t) => {
            const n = selectedRows.filter((r) => t.from.includes(r.status)).length;
            return (
              <button key={t.status} type="button" disabled={pending || n === 0} onClick={() => runBulk(t)} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 9, letterSpacing: "0.14em", padding: "6px 11px", background: palette.gold, color: palette.black, fontWeight: 600 }}>
                {t.label}{n > 0 ? ` · ${n}` : ""}
              </button>
            );
          })}
          <button type="button" onClick={() => setSelected(new Set())} className="font-body uppercase ml-auto" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.champagne }}>
            Clear
          </button>
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 820 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              <th style={{ width: 34, padding: "6px" }}>
                <button type="button" onClick={toggleAllVisible} aria-label={allVisibleSelected ? "Deselect all" : "Select all visible"}>
                  {allVisibleSelected ? <CheckSquare size={15} color={palette.goldDeep} /> : <Square size={15} color={palette.mutedGreige} />}
                </button>
              </th>
              <SortTh label="Order" k="order" sort={sort} onToggle={toggleSort} />
              <SortTh label="Business" k="business" sort={sort} onToggle={toggleSort} />
              <SortTh label="Source" k="source" sort={sort} onToggle={toggleSort} />
              <SortTh label="Status" k="status" sort={sort} onToggle={toggleSort} />
              <SortTh label="Total" k="total" sort={sort} onToggle={toggleSort} right defaultDir="desc" />
              <SortTh label="Advance" k="advance" sort={sort} onToggle={toggleSort} right defaultDir="desc" />
              <SortTh label="Balance" k="balance" sort={sort} onToggle={toggleSort} right defaultDir="desc" />
              <SortTh label="Date" k="date" sort={sort} onToggle={toggleSort} defaultDir="desc" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", background: selected.has(r.id) ? "rgba(196,163,90,0.08)" : "transparent" }}>
                <td style={{ padding: "6px", textAlign: "center" }}>
                  <button type="button" onClick={() => toggleRow(r.id)} aria-label={`Select ${r.order_number}`}>
                    {selected.has(r.id) ? <CheckSquare size={15} color={palette.goldDeep} /> : <Square size={15} color={palette.mutedGreige} />}
                  </button>
                </td>
                <td style={{ padding: "10px" }}><Link href={`/admin/orders/${r.id}`} className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>{r.order_number}</Link></td>
                <td className="font-body" style={{ fontSize: 12.5, color: palette.softBlack, padding: "10px" }}>{r.business}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px" }}>{SOURCE_LABEL[r.source]}</td>
                <td className="font-body uppercase" style={{ fontSize: 11, color: palette.softBlack, padding: "10px", letterSpacing: "0.06em" }}>{STATUS_LABEL[r.status]}</td>
                <td className="font-body text-right" style={{ fontSize: 12.5, color: palette.black, padding: "10px" }}>{formatINR(r.total)}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.advance > 0 ? formatINR(r.advance) : "—"}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: r.balance > 0 ? palette.crimsonText : palette.mutedGreige, padding: "10px" }}>{r.status === "cancelled" ? "—" : formatINR(r.balance)}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px", whiteSpace: "nowrap" }}>{fmt(r.submitted_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="text-center py-12 font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>No orders match.</div>}
      </div>

      {scanning && <QrScanner title="Scan a tag" onScan={handleScan} onClose={() => setScanning(false)} />}

      {toast && <div className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase z-[60]" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px" }}>{toast}</div>}
    </div>
  );
}

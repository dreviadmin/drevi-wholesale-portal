"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, X, ScanLine, Plus } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";

export interface ReceiptRow {
  id: string;
  number: string;
  vendor: string;
  date: string;
  lines: number;
  pieces: number;
  value: number;
  createdBy: string;
  skusText: string;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const istDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const ACCESSORS: Record<string, SortAccessor<ReceiptRow>> = {
  number: (r) => r.number,
  date: (r) => r.date,
  vendor: (r) => r.vendor,
  lines: (r) => r.lines,
  pieces: (r) => r.pieces,
  value: (r) => r.value,
  by: (r) => r.createdBy,
};

export function ReceiptsView({ rows, vendors }: { rows: ReceiptRow[]; vendors: string[] }) {
  const [query, setQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState("All");
  const [range, setRange] = useState<"today" | "7d" | "all">("all");
  const [from, setFrom] = useState("");
  const [scanning, setScanning] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const today = istDay(new Date());
    const cutoff7 = istDay(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    return rows.filter((r) => {
      if (vendorFilter !== "All" && r.vendor !== vendorFilter) return false;
      if (range === "today" && r.date !== today) return false;
      if (range === "7d" && r.date < cutoff7) return false;
      if (from && r.date < from) return false;
      if (!q) return true;
      return r.number.toLowerCase().includes(q) || r.vendor.toLowerCase().includes(q) || r.skusText.toLowerCase().includes(q);
    });
  }, [rows, query, vendorFilter, range, from]);

  const { sorted, sort, toggle } = useSort(filtered, ACCESSORS, { key: "date", dir: "desc" });
  const totals = useMemo(() => filtered.reduce((t, r) => ({ pieces: t.pieces + r.pieces, value: t.value + r.value }), { pieces: 0, value: 0 }), [filtered]);

  // Scanning a garment tag filters to receipts containing it (same as Orders).
  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty scan" };
    const hits = rows.filter((r) => r.skusText.includes(sku)).length;
    setScanning(false);
    setQuery(sku);
    return hits > 0
      ? { ok: true, message: `${sku} — in ${hits} receipt${hits > 1 ? "s" : ""}` }
      : { ok: false, message: `${sku} — no receipts contain it` };
  }

  const chip = (active: boolean) => ({ fontSize: 9, letterSpacing: "0.14em", padding: "5px 10px", color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.18)" });

  return (
    <div className="px-4 md:px-6 py-5 max-w-4xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Goods Receipts</h1>
        <Link href="/admin/receipts/new" className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "9px 16px" }}>
          <Plus size={13} strokeWidth={2.5} /> New Receipt
        </Link>
      </div>

      <div className="mt-4 flex items-center gap-2 max-w-md" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px" }}>
        <Search size={15} color={palette.mutedGreige} strokeWidth={1.7} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search number, vendor or SKU" className="font-body bg-transparent outline-none w-full" style={{ fontSize: 12.5, color: palette.black }} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} color={palette.mutedGreige} /></button>}
        <button type="button" onClick={() => setScanning(true)} aria-label="Scan a tag to find its receipts" className="flex items-center gap-1.5 font-body uppercase flex-shrink-0" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}>
          <ScanLine size={13} strokeWidth={1.7} /> Scan
        </button>
      </div>

      <div className="mt-3 flex gap-1.5 flex-wrap items-center">
        {(["today", "7d", "all"] as const).map((r) => (
          <button key={r} type="button" onClick={() => setRange(r)} className="font-body uppercase" style={{ ...chip(range === r), background: range === r ? palette.goldDeep : "transparent", border: range === r ? "none" : "1px solid rgba(26,26,26,0.18)" }}>
            {r === "today" ? "Today" : r === "7d" ? "7 Days" : "All"}
          </button>
        ))}
        <span style={{ width: 1, background: "rgba(26,26,26,0.15)", margin: "0 4px", alignSelf: "stretch" }} />
        <button type="button" onClick={() => setVendorFilter("All")} className="font-body uppercase" style={chip(vendorFilter === "All")}>All vendors</button>
        {vendors.map((v) => (
          <button key={v} type="button" onClick={() => setVendorFilter(v)} className="font-body" style={{ ...chip(vendorFilter === v), textTransform: "none", letterSpacing: "0.02em", fontSize: 10.5 }}>{v}</button>
        ))}
        <label className="flex items-center gap-1.5 ml-2 font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "4px 6px", fontSize: 11 }} />
        </label>
      </div>

      <div className="mt-3 font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>
        {filtered.length} receipt{filtered.length === 1 ? "" : "s"} · {totals.pieces} pc · <b>{formatINR(totals.value)}</b>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 700 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              <SortTh label="Number" k="number" sort={sort} onToggle={toggle} />
              <SortTh label="Date" k="date" sort={sort} onToggle={toggle} defaultDir="desc" />
              <SortTh label="Vendor" k="vendor" sort={sort} onToggle={toggle} />
              <SortTh label="Lines" k="lines" sort={sort} onToggle={toggle} right defaultDir="desc" />
              <SortTh label="Pieces" k="pieces" sort={sort} onToggle={toggle} right defaultDir="desc" />
              <SortTh label="Value" k="value" sort={sort} onToggle={toggle} right defaultDir="desc" />
              <SortTh label="By" k="by" sort={sort} onToggle={toggle} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <td style={{ padding: "10px" }}><Link href={`/admin/receipts/${r.id}`} className="font-mono" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>{r.number}</Link></td>
                <td className="font-body" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px", whiteSpace: "nowrap" }}>{fmtDate(r.date)}</td>
                <td className="font-body" style={{ fontSize: 12.5, color: palette.softBlack, padding: "10px" }}>{r.vendor}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.lines}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.black, padding: "10px" }}>{r.pieces}</td>
                <td className="font-body text-right" style={{ fontSize: 12.5, color: palette.black, padding: "10px" }}>{formatINR(r.value)}</td>
                <td className="font-body" style={{ fontSize: 11, color: palette.mutedGreige, padding: "10px" }}>{r.createdBy.split("@")[0]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="text-center py-10 font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>No receipts match.</div>}
      </div>

      {scanning && <QrScanner title="Scan a tag" onScan={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}

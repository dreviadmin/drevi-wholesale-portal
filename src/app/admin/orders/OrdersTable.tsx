"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import type { OrderStatus, OrderSource } from "@/lib/types";

export interface OrderRowDTO {
  id: string;
  order_number: string;
  business: string;
  total: number;
  status: OrderStatus;
  source: OrderSource;
  submitted_at: string;
}

const STATUSES: OrderStatus[] = ["submitted", "confirmed", "fulfilled", "cancelled"];
const SOURCES: OrderSource[] = ["portal_self_service", "exhibition", "in_store"];
const SOURCE_LABEL: Record<OrderSource, string> = { portal_self_service: "Portal", exhibition: "Exhibition", in_store: "In-store" };

function fmt(iso: string) { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }

export function OrdersTable({ rows }: { rows: OrderRowDTO[] }) {
  const [status, setStatus] = useState<Set<OrderStatus>>(new Set());
  const [source, setSource] = useState<Set<OrderSource>>(new Set());
  const [from, setFrom] = useState("");

  const filtered = useMemo(() => rows.filter((r) => {
    if (status.size && !status.has(r.status)) return false;
    if (source.size && !source.has(r.source)) return false;
    if (from && r.submitted_at < from) return false;
    return true;
  }), [rows, status, source, from]);

  function toggle<T>(set: Set<T>, v: T, setter: (s: Set<T>) => void) {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setter(n);
  }
  const chip = (active: boolean) => ({ fontSize: 9, letterSpacing: "0.14em", padding: "5px 10px", color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.18)" });

  return (
    <div className="px-4 md:px-8 py-6">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Orders</h1>

      <div className="mt-4 flex gap-1.5 flex-wrap items-center">
        {STATUSES.map((s) => <button key={s} type="button" onClick={() => toggle(status, s, setStatus)} className="font-body uppercase" style={chip(status.has(s))}>{s}</button>)}
        <span style={{ width: 1, background: "rgba(26,26,26,0.15)", margin: "0 4px", alignSelf: "stretch" }} />
        {SOURCES.map((s) => <button key={s} type="button" onClick={() => toggle(source, s, setSource)} className="font-body uppercase" style={chip(source.has(s))}>{SOURCE_LABEL[s]}</button>)}
        <label className="flex items-center gap-1.5 ml-2 font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "4px 6px", fontSize: 11 }} />
        </label>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 640 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              {["Order", "Business", "Source", "Status", "Total", "Date"].map((h) => (
                <th key={h} className="font-body uppercase text-left" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige, padding: "8px 10px", fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <td style={{ padding: "10px" }}><Link href={`/admin/orders/${r.id}`} className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black }}>{r.order_number}</Link></td>
                <td className="font-body" style={{ fontSize: 12.5, color: palette.softBlack, padding: "10px" }}>{r.business}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px" }}>{SOURCE_LABEL[r.source]}</td>
                <td className="font-body uppercase" style={{ fontSize: 11, color: palette.softBlack, padding: "10px", letterSpacing: "0.06em" }}>{r.status}</td>
                <td className="font-body" style={{ fontSize: 12.5, color: palette.black, padding: "10px" }}>{formatINR(r.total)}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px" }}>{fmt(r.submitted_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center py-12 font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>No orders match.</div>}
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, Plus, MessageCircle } from "lucide-react";
import { StatusPill, SourcePill } from "@/components/admin/Pills";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { palette } from "@/lib/palette";
import type { BuyerStatus, BuyerSource } from "@/lib/types";

export interface BuyerRowDTO {
  id: string;
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
  email: string | null;
  status: BuyerStatus;
  source: BuyerSource;
  created_at: string;
  ordersCount: number;
  lastOrder: string | null;
}

const STATUSES: BuyerStatus[] = ["pending", "active", "suspended", "rejected"];
const SOURCES: BuyerSource[] = ["inquiry_form", "exhibition", "manual_admin"];
const SOURCE_LABEL: Record<BuyerSource, string> = { inquiry_form: "Inquiry", exhibition: "Exhibition", manual_admin: "Manual" };

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
}
function waLink(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "");
  return digits ? `https://wa.me/${digits}` : null;
}

const ACCESSORS: Record<string, SortAccessor<BuyerRowDTO>> = {
  business: (r) => r.business_name,
  owner: (r) => r.owner_name,
  phone: (r) => r.phone,
  city: (r) => r.city,
  status: (r) => r.status,
  source: (r) => SOURCE_LABEL[r.source],
  orders: (r) => r.ordersCount,
  lastOrder: (r) => r.lastOrder,
  created: (r) => r.created_at,
};

export function BuyersTable({ rows }: { rows: BuyerRowDTO[] }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<BuyerStatus>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<Set<BuyerSource>>(new Set());

  const pendingCount = useMemo(() => rows.filter((r) => r.status === "pending").length, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter.size && !statusFilter.has(r.status)) return false;
      if (sourceFilter.size && !sourceFilter.has(r.source)) return false;
      if (!q) return true;
      return [r.business_name, r.owner_name, r.phone, r.email].some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, query, statusFilter, sourceFilter]);

  function toggle<T>(set: Set<T>, value: T, setter: (s: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const { sorted, sort, toggle: toggleSort } = useSort(filtered, ACCESSORS);

  const chip = (active: boolean) => ({
    fontSize: 9,
    letterSpacing: "0.14em",
    padding: "5px 10px",
    color: active ? palette.ivory : palette.softBlack,
    background: active ? palette.black : "transparent",
    border: active ? "none" : "1px solid rgba(26,26,26,0.18)",
  });

  return (
    <div className="px-4 md:px-8 py-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Buyers</h1>
        <Link href="/admin/buyers/new" className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "9px 16px" }}>
          <Plus size={13} strokeWidth={2.5} /> Add Buyer
        </Link>
      </div>

      {pendingCount > 0 && (
        <button
          type="button"
          onClick={() => setStatusFilter(new Set(["pending"]))}
          className="mt-3 font-body"
          style={{ fontSize: 11, color: palette.goldDeep, letterSpacing: "0.04em" }}
        >
          {pendingCount} pending buyer{pendingCount > 1 ? "s" : ""} — review →
        </button>
      )}

      {/* Controls */}
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "8px 10px", maxWidth: 360 }}>
          <Search size={15} strokeWidth={1.7} color={palette.mutedGreige} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search business, owner, phone, email"
            className="font-body bg-transparent outline-none w-full"
            style={{ fontSize: 12, color: palette.black }}
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {STATUSES.map((s) => (
            <button key={s} type="button" onClick={() => toggle(statusFilter, s, setStatusFilter)} className="font-body uppercase" style={chip(statusFilter.has(s))}>{s}</button>
          ))}
          <span style={{ width: 1, background: "rgba(26,26,26,0.15)", margin: "0 4px" }} />
          {SOURCES.map((s) => (
            <button key={s} type="button" onClick={() => toggle(sourceFilter, s, setSourceFilter)} className="font-body uppercase" style={chip(sourceFilter.has(s))}>{SOURCE_LABEL[s]}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 760 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              <SortTh label="Business" k="business" sort={sort} onToggle={toggleSort} />
              <SortTh label="Owner" k="owner" sort={sort} onToggle={toggleSort} />
              <SortTh label="Phone" k="phone" sort={sort} onToggle={toggleSort} />
              <SortTh label="City" k="city" sort={sort} onToggle={toggleSort} />
              <SortTh label="Status" k="status" sort={sort} onToggle={toggleSort} />
              <SortTh label="Source" k="source" sort={sort} onToggle={toggleSort} />
              <SortTh label="Orders" k="orders" sort={sort} onToggle={toggleSort} defaultDir="desc" />
              <SortTh label="Last order" k="lastOrder" sort={sort} onToggle={toggleSort} defaultDir="desc" />
              <SortTh label="Created" k="created" sort={sort} onToggle={toggleSort} defaultDir="desc" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const wa = waLink(r.phone);
              return (
                <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                  <td style={{ padding: "10px" }}>
                    <Link href={`/admin/buyers/${r.id}`} className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{r.business_name ?? "—"}</Link>
                  </td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.owner_name ?? "—"}</td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>
                    <span className="inline-flex items-center gap-1.5">
                      {r.phone ?? "—"}
                      {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label="WhatsApp"><MessageCircle size={13} strokeWidth={1.7} color={palette.goldDeep} /></a>}
                    </span>
                  </td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.city ?? "—"}</td>
                  <td style={{ padding: "10px" }}><StatusPill status={r.status} /></td>
                  <td style={{ padding: "10px" }}><SourcePill source={r.source} /></td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.ordersCount}</td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{fmtDate(r.lastOrder)}</td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px" }}>{fmtDate(r.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 font-body" style={{ fontSize: 12, color: palette.mutedGreige, letterSpacing: "0.08em" }}>No buyers match.</div>
        )}
      </div>
    </div>
  );
}

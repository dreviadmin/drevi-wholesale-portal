"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, Download } from "lucide-react";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { palette } from "@/lib/palette";
import { toCsv } from "@/lib/dashboard/csv";
import type { SortState } from "@/lib/dashboard/state";

const PAGE = 200;
const columnsNamedOnPhone = ["product", "vendor", "customer", "category", "event", "order", "date", "vendorSku"];

export interface Column<T> {
  key: string;
  label: string;
  right?: boolean;
  bold?: boolean;
  defaultDir?: "asc" | "desc";
  width?: number;
  render: (row: T) => React.ReactNode;
  csv?: (row: T) => string | number | null | undefined;
}

/** How a row reads on a phone: name, one line, one number. */
export interface PhoneRow {
  image?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  extra?: React.ReactNode;
  value?: React.ReactNode;
  valueLabel?: string;
  action?: React.ReactNode;
}

/** Tapping the row is a pointer convenience: the real link is the one marked data-primary. */
function tapPrimary(e: React.MouseEvent<HTMLElement>) {
  if ((e.target as Element).closest("a,button,input,label,select,summary")) return;
  if (window.getSelection()?.isCollapsed === false) return; // copying a number, not opening the row
  const link = e.currentTarget.querySelector<HTMLAnchorElement>("a[data-primary]");
  if (!link) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey) window.open(link.href, "_blank", "noopener");
  else link.click();
}

/** Opens in place on a plain tap. A ctrl- or cmd-click still goes to a new tab. */
export function DrillLink({ href, onGo, children, className, style, primary, label, current }: {
  href: string;
  onGo: () => void;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  primary?: boolean;
  label?: string;
  current?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      data-primary={primary ? "" : undefined}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      className={className}
      style={style}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onGo();
      }}
    >
      {children}
    </Link>
  );
}

export function DrillTable<T>({ rows, columns, accessors, sort, onSort, rowKey, phone, csvName, tappable = true, highlight }: {
  rows: T[];
  columns: Column<T>[];
  accessors: Record<string, SortAccessor<T>>; // a module constant: it is a memo dependency
  sort: SortState;
  onSort: (next: SortState) => void;
  rowKey: (row: T) => string;
  phone: (row: T) => PhoneRow;
  csvName: string;
  tappable?: boolean;
  highlight?: (row: T) => boolean;
}) {
  const { sorted, toggle } = useSort(rows, accessors, undefined, { sort, onSort });
  const [limit, setLimit] = useState(PAGE);
  const shown = sorted.slice(0, limit);
  const left = sorted.length - shown.length;
  const sortable = columns.filter((c) => accessors[c.key]);
  const active = columns.find((c) => c.key === sort.key);

  function download() {
    const cols = columns.filter((c) => c.csv);
    const csv = toCsv(cols.map((c) => c.label), sorted.map((r) => cols.map((c) => c.csv!(r))));
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${csvName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {/* Laptop: the full table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${palette.black}` }}>
            {columns.map((c) => (accessors[c.key]
              ? <SortTh key={c.key} label={c.label} k={c.key} sort={sort} onToggle={toggle} right={c.right} defaultDir={c.defaultDir ?? (c.right ? "desc" : "asc")} />
              : <th key={c.key} aria-label={c.label || "Photo"} />))}
          </tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={rowKey(r)}
                onClick={tappable ? tapPrimary : undefined}
                className={tappable ? "dash-row" : undefined}
                style={{ borderBottom: "1px solid rgba(26,26,26,0.07)", background: highlight?.(r) ? palette.ivoryDeep : undefined, cursor: tappable ? "pointer" : undefined }}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={c.bold ? "font-display" : "font-body"}
                    style={{ fontSize: c.bold ? 13 : 12, fontWeight: c.bold ? 600 : 400, color: palette.black, textAlign: c.right ? "right" : "left", padding: "8px 10px", whiteSpace: "nowrap", width: c.width }}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone: a table this wide would leave the names off-screen */}
      <div className="md:hidden">
        {sortable.length > 1 && (
          <label className="flex items-center gap-2 font-body mb-1" style={{ fontSize: 11, color: palette.mutedGreige }}>
            Sort by
            <select
              value={sort.key}
              onChange={(e) => {
                const col = columns.find((c) => c.key === e.target.value);
                onSort({ key: e.target.value, dir: col?.defaultDir ?? (col?.right ? "desc" : "asc") });
              }}
              className="font-body bg-transparent"
              style={{ fontSize: 12, color: palette.black, border: "none", borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 0" }}
            >
              {sortable.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        )}
        {shown.map((r) => {
          const m = phone(r);
          const showSorted = active?.right;
          // A sort on something the row does not otherwise show would look random.
          const showInSub = !!active && !active.right && !columnsNamedOnPhone.includes(active.key);
          return (
            <div
              key={rowKey(r)}
              onClick={tappable ? tapPrimary : undefined}
              className="flex items-center gap-2.5 py-2.5"
              style={{ borderBottom: "1px solid rgba(26,26,26,0.07)", background: highlight?.(r) ? palette.ivoryDeep : undefined }}
            >
              {m.image}
              <div className="min-w-0 flex-1">
                <div className="font-display truncate" style={{ fontSize: 13.5, fontWeight: 500, color: palette.black }}>{m.title}</div>
                {m.sub && (
                  <div className="font-body truncate" style={{ fontSize: 11, color: palette.mutedGreige }}>
                    {m.sub}{showInSub && <> · {active.render(r)}</>}
                  </div>
                )}
                {m.extra}
              </div>
              <div className="text-right flex-none">
                <div className="font-display" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>{showSorted ? active.render(r) : m.value}</div>
                <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.08em", color: palette.softBlack }}>{showSorted ? active.label : m.valueLabel}</div>
              </div>
              {m.action}
              {tappable && <ChevronRight size={14} color={palette.mutedGreige} aria-hidden className="flex-none" />}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 mt-2">
        {left > 0
          ? <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", padding: "7px 12px", border: "1px solid rgba(26,26,26,0.18)", color: palette.softBlack }}>Show {Math.min(left, PAGE)} more ({left} left)</button>
          : <span />}
        <button type="button" onClick={download} className="hidden md:inline-flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige }}>
          <Download size={12} strokeWidth={1.7} /> Download CSV
        </button>
      </div>
    </>
  );
}

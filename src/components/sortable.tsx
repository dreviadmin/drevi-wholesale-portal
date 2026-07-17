"use client";

import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { palette } from "@/lib/palette";

// Golden rule: every data table sorts by clicking its column headers.
// useSort() owns the state + comparator; SortTh renders the house-style
// header cell with the active-direction indicator. First click applies the
// column's natural direction (numbers/dates default desc, text asc);
// clicking again flips it. Null/blank values always sink to the bottom.

export type SortDir = "asc" | "desc";
export interface SortState { key: string; dir: SortDir }
export type SortAccessor<T> = (row: T) => string | number | null | undefined;

export function useSort<T>(
  rows: T[],
  accessors: Record<string, SortAccessor<T>>,
  initial?: SortState,
) {
  const [sort, setSort] = useState<SortState | null>(initial ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const acc = accessors[sort.key];
    if (!acc) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = acc(a);
      const vb = acc(b);
      const aBlank = va == null || va === "";
      const bBlank = vb == null || vb === "";
      if (aBlank && bBlank) return 0;
      if (aBlank) return 1;
      if (bBlank) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
  }, [rows, sort, accessors]);

  function toggle(key: string, defaultDir: SortDir = "asc") {
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir }));
  }
  return { sorted, sort, toggle };
}

export function SortTh({
  label,
  k,
  sort,
  onToggle,
  right = false,
  defaultDir = "asc",
}: {
  label: string;
  k: string;
  sort: SortState | null;
  onToggle: (key: string, defaultDir: SortDir) => void;
  right?: boolean;
  defaultDir?: SortDir;
}) {
  const active = sort?.key === k;
  return (
    <th style={{ padding: 0, textAlign: right ? "right" : "left" }}>
      <button
        type="button"
        onClick={() => onToggle(k, defaultDir)}
        aria-label={`Sort by ${label}`}
        className={`font-body uppercase inline-flex items-center gap-1 w-full ${right ? "justify-end" : "justify-start"}`}
        style={{
          fontSize: 9,
          letterSpacing: "0.14em",
          color: active ? palette.black : palette.mutedGreige,
          fontWeight: active ? 700 : 500,
          padding: "8px 10px",
          background: "none",
          border: "none",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {label}
        {active
          ? sort!.dir === "asc" ? <ChevronUp size={11} strokeWidth={2.4} /> : <ChevronDown size={11} strokeWidth={2.4} />
          : <ChevronsUpDown size={10} strokeWidth={1.6} style={{ opacity: 0.45 }} />}
      </button>
    </th>
  );
}

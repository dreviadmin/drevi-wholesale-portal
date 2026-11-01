"use client";

import { useMemo, useRef, useState } from "react";
import { Search, X, ScanLine } from "lucide-react";
import { palette } from "@/lib/palette";
import { searchFind, type FindEntry } from "@/lib/dashboard/find";

const KIND_LABEL: Record<FindEntry["kind"], string> = {
  design: "Product", vendor: "Vendor", customer: "Customer", category: "Category", event: "Exhibition", order: "Order",
};

export function FindBox({ index, query, onQuery, onPick, onScan, placeholder }: {
  index: FindEntry[];
  query: string;
  onQuery: (q: string) => void;
  onPick: (entry: FindEntry) => void;
  onScan: () => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => (open ? searchFind(index, query) : []), [open, index, query]);

  function pick(entry: FindEntry) {
    setOpen(false);
    onQuery("");
    inputRef.current?.blur();
    onPick(entry);
  }

  return (
    <div className="relative flex-1 min-w-0 md:max-w-md">
      <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "5px 6px 5px 10px", background: palette.pageBg }}>
        <Search size={14} color={palette.mutedGreige} strokeWidth={1.7} className="flex-none" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { onQuery(e.target.value); setOpen(true); setCursor(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setOpen(false); return; }
            if (!hits.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % hits.length); }
            if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + hits.length) % hits.length); }
            if (e.key === "Enter") { e.preventDefault(); pick(hits[cursor]); }
          }}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="dash-find-results"
          aria-label="Find a product, vendor, customer or order"
          placeholder={placeholder}
          className="font-body bg-transparent outline-none w-full min-w-0"
          style={{ fontSize: 12.5, color: palette.black }}
        />
        {query && (
          <button type="button" onClick={() => onQuery("")} aria-label="Clear search" className="flex-none" style={{ padding: 7, margin: -7 }}>
            <X size={14} color={palette.mutedGreige} />
          </button>
        )}
        <button
          type="button"
          onClick={onScan}
          aria-label="Scan a tag"
          className="flex items-center gap-1.5 font-body uppercase flex-none"
          style={{ fontSize: 9, letterSpacing: "0.12em", padding: "5px 8px", minHeight: 28, minWidth: 32, background: palette.black, color: palette.ivory }}
        >
          <ScanLine size={13} strokeWidth={1.7} /> <span className="hidden md:inline">Scan</span>
        </button>
      </div>
      {open && hits.length === 0 && query.trim().length >= 2 && (
        <p className="absolute left-0 right-0 z-50 font-body" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.18)", borderTop: "none", padding: "8px 10px", fontSize: 12, color: palette.mutedGreige }}>
          Nothing found for &ldquo;{query.trim()}&rdquo;
        </p>
      )}
      {hits.length > 0 && (
        <ul id="dash-find-results" role="listbox" className="absolute left-0 right-0 z-50" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.18)", borderTop: "none", boxShadow: "0 6px 18px rgba(26,26,26,0.12)" }}>
          {hits.map((h, i) => (
            <li key={`${h.kind}:${h.value}`} role="option" aria-selected={i === cursor}>
              {/* onMouseDown, so the input's blur does not close the list first */}
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pick(h); }}
                className="w-full text-left flex items-center justify-between gap-3"
                style={{ padding: "8px 10px", background: i === cursor ? palette.ivoryDeep : "transparent" }}
              >
                <span className="min-w-0">
                  <span className="font-display block truncate" style={{ fontSize: 13, fontWeight: 500, color: palette.black }}>{h.title}</span>
                  {h.sub && <span className="font-body block truncate" style={{ fontSize: 10, color: palette.mutedGreige }}>{h.sub}</span>}
                </span>
                <span className="font-body uppercase flex-none" style={{ fontSize: 8, letterSpacing: "0.12em", color: palette.goldDeep }}>{KIND_LABEL[h.kind]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { palette } from "@/lib/palette";
import { rankColors, findColorName, type ColorGroups } from "@/lib/sku/color-search";

// Shared colour picker (Ansh, UX sprint): typeahead over the live colour LoV,
// grouped list while the query is blank, keyboard navigation, and a selected
// chip with clear. Used by the SKU generator and the Log delivery sheet.
export function ColorCombobox({
  value,
  onChange,
  groups,
  placeholder,
  style,
  autoFocus,
  id,
}: {
  value: string;
  onChange: (code: string) => void;
  groups: ColorGroups;
  placeholder?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  id?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);

  const list = useMemo(() => rankColors(query, groups), [query, groups]);
  const name = findColorName(value, groups);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [idx, open]);
  // The input only mounts once the value is cleared, so focus lands one render later.
  useEffect(() => {
    if (!value && wantFocus.current) { wantFocus.current = false; inputRef.current?.focus(); }
  }, [value]);

  function pick(code: string) { onChange(code); setQuery(""); setOpen(false); }
  function clear() { onChange(""); setQuery(""); setOpen(true); }
  function reopen() { wantFocus.current = true; clear(); }

  if (value) {
    return (
      <div className="flex items-center gap-2" style={{ ...style, padding: "7px 9px" }}>
        <button type="button" onClick={reopen} className="flex items-center gap-2 flex-1 text-left min-w-0">
          <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 700, color: palette.black }}>{value}</span>
          <span className="font-body truncate" style={{ fontSize: 12, color: palette.softBlack }}>{name ?? ""}</span>
        </button>
        <button type="button" aria-label="Clear colour" onClick={clear}><X size={14} color={palette.mutedGreige} /></button>
      </div>
    );
  }

  const blank = query.trim() === "";
  const option = (code: string, label: string, i: number) => (
    <button
      key={code}
      type="button"
      role="option"
      aria-selected={i === idx}
      onPointerDown={(e) => { e.preventDefault(); pick(code); }}
      className="w-full text-left px-3 py-2 font-body"
      style={{ fontSize: 12.5, background: i === idx ? palette.ivoryDeep : undefined, borderBottom: "1px solid rgba(26,26,26,0.04)" }}
    >
      <span className="font-mono" style={{ fontWeight: 700 }}>{code}</span> — {label}
    </button>
  );
  let flat = 0;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listId}
        autoCapitalize="characters"
        autoComplete="off"
        autoFocus={autoFocus}
        value={query}
        placeholder={placeholder ?? "Type a colour or code"}
        className="font-body w-full bg-transparent outline-none"
        style={style}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setIdx(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setIdx((i) => Math.min(i + 1, Math.max(list.length - 1, 0))); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); if (open && list.length > 0) { const c = list[Math.min(idx, list.length - 1)]; if (c) pick(c[0]); } }
          else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
        }}
      />
      {open && (
        <div ref={listRef} id={listId} role="listbox" className="absolute z-20 w-full max-h-64 overflow-y-auto" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.15)", boxShadow: "0 8px 24px rgba(26,26,26,0.12)" }}>
          {blank
            ? groups.map((g) => (
                <div key={g.name}>
                  <div className="font-body uppercase px-3 py-1.5" style={{ fontSize: 8, letterSpacing: "0.16em", color: palette.goldDeep, background: palette.ivoryDeep }}>{g.name}</div>
                  {g.items.map(([code, label]) => option(code, label, flat++))}
                </div>
              ))
            : list.map(([code, label], i) => option(code, label, i))}
          {!blank && list.length === 0 && <div className="font-body p-3" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No colours match.</div>}
        </div>
      )}
    </div>
  );
}

"use client";

import { useId } from "react";

// Shared HSN field (Ansh, 31 Jul): free text + a datalist of every code
// already in use, so the same code is picked, not re-typed.
export function HsnInput({
  value,
  onChange,
  options,
  placeholder = "e.g. 6204",
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const listId = useId();
  return (
    <>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        inputMode="numeric"
        placeholder={placeholder}
        className="font-mono bg-transparent outline-none"
        style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13, ...style }}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { parseQtyInput } from "@/lib/qty-input";
import { palette } from "@/lib/palette";

/**
 * The number between − and + on the cart and product pages, typed rather than
 * tapped (Oct review). Holds a draft while the buyer types and commits on blur
 * or Enter; an empty or invalid entry puts the last good value back. 16px so
 * iPhone Safari does not zoom the page when it is focused.
 */
export function QtyField({
  value,
  min,
  onCommit,
  disabled = false,
  width = 44,
  height = 40,
}: {
  value: number;
  min: number;
  onCommit: (qty: number) => void;
  disabled?: boolean;
  width?: number;
  height?: number;
}) {
  const [draft, setDraft] = useState(String(value));

  // Back to the real value when it changes, and when a save finishes: the
  // server may clamp, and a clamp back to the same number changes nothing
  // the field could otherwise see.
  useEffect(() => {
    if (!disabled) setDraft(String(value));
  }, [value, disabled]);

  function commit() {
    const n = parseQtyInput(draft, min);
    if (n == null || n === value) {
      setDraft(String(value));
      return;
    }
    setDraft(String(n));
    onCommit(n);
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label="Quantity"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="font-body bg-transparent outline-none text-center disabled:opacity-50"
      style={{ width, height, fontSize: 16, color: palette.black, padding: 0 }}
    />
  );
}

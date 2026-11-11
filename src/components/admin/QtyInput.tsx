"use client";

import { useState, type CSSProperties } from "react";
import { parseReceiptQtyInput, QTY_MAX } from "@/lib/qty-input";

// The typed quantity between the − / + steppers. Focusing it empties the
// field (the current number stays as the placeholder) so typing replaces it —
// select-on-focus is unreliable on iOS for number inputs. Every keystroke
// commits the number it stands for; leaving the field shows the clamped value.
// 16px, so iOS does not zoom the page when it is tapped.
export function QtyInput({ value, onChange, label, className = "", style }: {
  value: number;
  onChange: (qty: number) => void;
  /** read by screen readers, e.g. "M quantity" */
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [text, setText] = useState<string | null>(null); // null = not being edited
  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      max={QTY_MAX}
      step={1}
      aria-label={label}
      value={text ?? String(value)}
      placeholder={String(value)}
      onFocus={() => setText("")}
      onChange={(e) => {
        setText(e.target.value);
        const next = parseReceiptQtyInput(e.target.value, value);
        if (next !== value) onChange(next);
      }}
      onBlur={() => setText(null)}
      className={`text-center bg-transparent outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${className}`}
      style={{ fontSize: 16, width: "4.5ch", padding: "4px 0", ...style }}
    />
  );
}

"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { palette } from "@/lib/palette";

/**
 * Copies `value` for the buyer to paste into the courier's tracking page.
 * Where the clipboard is refused (an older in-app browser, a non-secure
 * page), the text with id `selectId` is selected instead, so a long-press
 * copies it by hand.
 */
export function CopyButton({ value, label, selectId }: { value: string; label: string; selectId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      /* fallback below */
    }
    if (!ok) {
      const el = document.getElementById(selectId);
      const sel = window.getSelection();
      if (el && sel) {
        sel.selectAllChildren(el);
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      className="flex items-center justify-center gap-1.5 font-body uppercase shrink-0"
      style={{ minHeight: 44, minWidth: 44, padding: "0 14px", border: `1px solid ${palette.black}`, color: palette.black, fontSize: 11, letterSpacing: "0.15em" }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

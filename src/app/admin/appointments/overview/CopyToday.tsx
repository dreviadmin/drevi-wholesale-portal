"use client";

import { Copy } from "lucide-react";
import { useToast } from "@/lib/use-toast";
import { btn } from "../ui";
import { FOCUS, ToastBar } from "./parts";

/** Copies today's list as plain text for the staff WhatsApp group. The text is built on the server. */
export function CopyToday({ text, count }: { text: string; count: number }) {
  const [toast, flash] = useToast();

  async function copy() {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* older in-app browsers: fallback below */ }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      document.body.removeChild(ta);
    }
    flash(ok ? `Copied today's ${count} appointment${count === 1 ? "" : "s"}. Paste it in the staff WhatsApp group.` : "This browser would not copy. Open the portal in Chrome or Safari and try again.");
  }

  return (
    <>
      <button type="button" onClick={copy} className={FOCUS} style={{ ...btn("outline", true), minHeight: 44 }} aria-label="Copy today's list for the staff WhatsApp group">
        <Copy size={13} aria-hidden /> Copy today&apos;s list
      </button>
      <ToastBar message={toast} />
    </>
  );
}

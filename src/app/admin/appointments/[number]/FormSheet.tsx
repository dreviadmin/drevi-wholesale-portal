"use client";

// A bottom sheet on phones, centred from md up, for the longer forms (Move,
// Edit details). Same look as ConfirmSheet; adds a disabled state for the
// main button and room for a wider form.

import { useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { palette } from "@/lib/palette";
import { FOCUS } from "../new/fields";

export function FormSheet({ title, children, confirmLabel, pendingLabel, tone = "plain", pending, error, disabled, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; pendingLabel?: string; tone?: "plain" | "danger";
  pending: boolean; error: string | null; disabled?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !pending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onClose]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={() => !pending && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full md:max-w-2xl max-h-modal overflow-y-auto overflow-x-hidden text-left"
        style={{ background: palette.ivory, padding: "18px 16px", paddingBottom: "calc(18px + var(--kb-inset, 0px) + env(safe-area-inset-bottom, 0px))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
          <h2 id={titleId} className="font-body uppercase" style={{ flex: 1, fontSize: 11, letterSpacing: "0.2em", color: palette.softBlack, fontWeight: 600 }}>{title}</h2>
          <button type="button" aria-label="Close" disabled={pending} onClick={onClose} className={FOCUS} style={{ width: 44, height: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", color: palette.softBlack }}>
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-4">{children}</div>
        {error ? <div role="alert" className="font-body mt-3" style={{ fontSize: 13, lineHeight: 1.5, color: "#9C3A31" }}>{error}</div> : null}
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            disabled={pending || disabled}
            onClick={onConfirm}
            className={`flex-1 font-body uppercase disabled:opacity-40 ${FOCUS}`}
            style={{ fontSize: 11, letterSpacing: "0.16em", background: tone === "danger" ? "#9C3A31" : palette.black, color: palette.ivory, minHeight: 48, padding: "0 12px" }}
          >
            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </button>
          <button type="button" disabled={pending} onClick={onClose} className={`font-body uppercase ${FOCUS}`} style={{ fontSize: 11, letterSpacing: "0.14em", color: palette.softBlack, minHeight: 48, padding: "0 14px" }}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { palette } from "@/lib/palette";

// The app's confirm sheet (review fix, Nov), lifted from CancelBillButton: a
// bottom sheet on phones, centred from md up. It stands in for the browser's
// confirm / prompt / alert, which phones show as a bare system box with no
// context. The caller renders it only while open and owns pending and error,
// so a refused action keeps the sheet up with the reason shown inside it.
export function ConfirmSheet({
  title,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Keep it",
  tone = "danger",
  reasonPlaceholder,
  pending = false,
  error = null,
  onConfirm,
  onClose,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  /** null hides the second button: a notice with a single OK. */
  cancelLabel?: string | null;
  /** danger: the crimson button of a cancel or void; plain: black (OK). */
  tone?: "danger" | "plain";
  /** When set, a reason is asked for and required; onConfirm receives it trimmed. */
  reasonPlaceholder?: string;
  pending?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const titleId = useId();
  const needsReason = reasonPlaceholder != null;
  const blocked = pending || (needsReason && !reason.trim());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !pending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={() => !pending && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full md:max-w-md max-h-modal overflow-y-auto text-left"
        // text-left / normal wrapping: it is often mounted inside a right-aligned,
        // nowrap table cell or action row, and would inherit both.
        style={{ background: palette.ivory, whiteSpace: "normal", padding: "20px 18px", paddingBottom: "calc(20px + var(--kb-inset, 0px) + env(safe-area-inset-bottom, 0px))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id={titleId} className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.2em", color: palette.softBlack }}>{title}</div>
        {children && <div className="font-body mt-2" style={{ fontSize: 13, lineHeight: 1.6, color: palette.softBlack }}>{children}</div>}
        {needsReason && (
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
            placeholder={reasonPlaceholder}
            aria-label={reasonPlaceholder}
            className="w-full mt-3 font-body"
            style={{ fontSize: 16, minHeight: 44, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" }}
          />
        )}
        {error && <div role="alert" className="font-body mt-2" style={{ fontSize: 13, lineHeight: 1.5, color: "#9C3A31" }}>{error}</div>}
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            disabled={blocked}
            onClick={() => onConfirm(reason.trim())}
            className="flex-1 font-body uppercase disabled:opacity-40"
            style={{ fontSize: 11, letterSpacing: "0.16em", background: tone === "danger" ? "#9C3A31" : palette.black, color: palette.ivory, minHeight: 44, padding: "0 12px" }}
          >
            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </button>
          {cancelLabel !== null && (
            <button
              type="button"
              disabled={pending}
              onClick={onClose}
              className="font-body uppercase"
              style={{ fontSize: 11, letterSpacing: "0.14em", color: palette.softBlack, minHeight: 44, padding: "0 14px" }}
            >
              {cancelLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

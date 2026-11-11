"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { X, QrCode, Printer, Tag, PackageCheck, SlidersHorizontal, PlusCircle, ShoppingBag, Palette as PaletteIcon, BarChart3 } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { palette } from "@/lib/palette";
import { t } from "@/lib/strings";
import { useToast } from "@/lib/use-toast";
import { queueTray } from "@/app/admin/sku-generator/labels";
import { mrpLabel, readResolved, scanVerdict, stockLabel, type ScanResolved } from "@/lib/scan-sheet-core";

// Global scan action sheet (build guide §6.5). The FAB opens the existing
// QrScanner; a decode resolves via /api/scan/resolve (server-side, role-gated
// actions) and this sheet presents them. Two actions are client-assembled:
// "Add to current bill" (only when a wizard draft with items exists in
// localStorage) and "Add to print sheet" (writes the Stage 1 tray).

// Long enough to see the scanner's verdict before the sheet replaces it.
const VERDICT_HOLD_MS = 400;

const ACTION_ICONS: Record<string, typeof Tag> = {
  retail_check: Tag,
  add_to_bill: ShoppingBag,
  sales: BarChart3,
  log_receipt: PackageCheck,
  open_studio: PaletteIcon,
  edit_master: SlidersHorizontal,
  add_to_print: Printer,
  create_sku: PlusCircle,
};

// A wizard draft ("drevi:wizard:<sessionId>", non-empty cart, not the
// ":parked" variant) → deep-link that consumes ?add= (guide: the sheet only
// offers add-to-bill when a draft exists this session).
function findWizardDraft(): { href: string } | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      const m = k.match(/^drevi:wizard:([0-9a-f-]{36})$/);
      if (!m) continue;
      const draft = JSON.parse(localStorage.getItem(k) ?? "{}");
      const cart = draft.cart ?? draft;
      if (cart && typeof cart === "object" && Object.keys(cart).length > 0) {
        return { href: `/admin/exhibition/${m[1]}` };
      }
    }
  } catch { /* corrupted key — no offer */ }
  return null;
}

export function ScanSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [resolved, setResolved] = useState<ScanResolved | null>(null);
  const [scanning, setScanning] = useState(true);
  const [toast, flash] = useToast();
  const scanReq = useRef(0);

  // Answers with a Promise, so the scanner shows "checking…" and only beeps
  // once the resolver has said whether the tag is known — it used to beep
  // success for every code, unknown ones included. A failed request or an
  // error reply (signed out, server error) rejects, which the scanner shows
  // as "could not check; retry" with the camera open.
  function handleScan(text: string): ScanFeedback | Promise<ScanFeedback> {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty code" };
    const req = ++scanReq.current;
    return fetch(`/api/scan/resolve?sku=${encodeURIComponent(sku)}`)
      .then(async (r) => readResolved(r.ok, await r.json()))
      .then((res) => {
        // A later scan overtook this one: beep for it, but show the latest.
        if (req === scanReq.current) {
          setResolved(res);
          setTimeout(() => { if (req === scanReq.current) setScanning(false); }, VERDICT_HOLD_MS);
        }
        return scanVerdict(res);
      });
  }

  function addToPrintTray(sku: string) {
    if (!queueTray([sku], "merge")) { flash("Could not write the print tray"); return; }
    flash(t("scan.added_to_print"));
  }

  const draft = resolved && resolved.known ? findWizardDraft() : null;

  const rows: { key: string; label: string; onTap: () => void }[] = (resolved?.actions ?? []).map((a) => ({
    key: a.key,
    label: a.label,
    onTap: () => {
      if (a.key === "add_to_print") { addToPrintTray(resolved!.sku); return; }
      if (a.href) { onClose(); router.push(a.href); }
    },
  }));
  if (draft && resolved) {
    rows.splice(1, 0, {
      key: "add_to_bill",
      label: t("scan.add_to_bill"),
      onTap: () => { onClose(); router.push(`${draft.href}?add=${encodeURIComponent(resolved.sku)}`); },
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.55)" }} onClick={onClose}>
      <div
        className="w-full md:w-[420px] max-h-modal overflow-y-auto"
        style={{ background: palette.ivory, borderRadius: "14px 14px 0 0" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.mutedGreige }}>
            {t("scan.title")}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1"><X size={16} color={palette.softBlack} /></button>
        </div>

        {scanning && (
          <div className="px-5 pb-5">
            <QrScanner onScan={handleScan} onClose={onClose} />
          </div>
        )}

        {!scanning && resolved && (
          <div className="px-5 pb-6">
            <div className="flex items-center gap-3">
              {resolved.thumb ? (
                <Image src={resolved.thumb} alt={resolved.sku} width={56} height={70} className="object-cover" unoptimized />
              ) : (
                <div className="flex items-center justify-center" style={{ width: 56, height: 70, background: palette.ivoryDeep }}>
                  <QrCode size={20} color={palette.mutedGreige} />
                </div>
              )}
              <div className="min-w-0">
                <div className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: palette.black }}>{resolved.sku}</div>
                <div className="font-body truncate" style={{ fontSize: 13, color: palette.softBlack }}>
                  {resolved.known ? resolved.title ?? "—" : t("scan.unknown")}
                </div>
                {resolved.known && (
                  <div className="font-body" style={{ fontSize: 13, color: palette.black, fontWeight: 600 }}>
                    {[mrpLabel(resolved), stockLabel(resolved)].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-col" style={{ borderTop: "1px solid rgba(26,26,26,0.08)" }}>
              {rows.map((r) => {
                const Icon = ACTION_ICONS[r.key] ?? Tag;
                return (
                  <button
                    key={r.key}
                    type="button"
                    onClick={r.onTap}
                    className="flex items-center gap-3 text-left font-body"
                    style={{ fontSize: 13.5, color: palette.black, padding: "13px 2px", borderBottom: "1px solid rgba(26,26,26,0.06)" }}
                  >
                    <Icon size={16} strokeWidth={1.7} color={palette.goldDeep} />
                    {r.label}
                  </button>
                );
              })}
              {rows.length === 0 && (
                <div className="font-body py-4" style={{ fontSize: 12.5, color: palette.mutedGreige }}>{t("scan.unknown")}</div>
              )}
            </div>

            <button
              type="button"
              onClick={() => { setResolved(null); setScanning(true); }}
              className="mt-4 w-full font-body uppercase"
              style={{ fontSize: 10, letterSpacing: "0.18em", padding: "11px 0", border: `1px solid ${palette.black}`, color: palette.black }}
            >
              {t("scan.rescan")}
            </button>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-24 left-1/2 -translate-x-1/2 font-body px-4 py-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

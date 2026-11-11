"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { palette } from "@/lib/palette";
import { ConfirmSheet } from "@/components/admin/ConfirmSheet";
import { voidRetailBill } from "./actions";

/**
 * Void through the confirm sheet (review fix: it was tiny grey text armed by a
 * single tap for 4 seconds) — stock returns, the row stays flagged.
 *
 * The page renders this for voided bills too (`voided`), in the same slot: the
 * void revalidates the page, and a warning ("stock did NOT return…") has to
 * stay on screen in the sheet until staff have read it, instead of vanishing
 * with the button.
 */
export function VoidBillButton({ billId, billNumber, total, voided = false }: { billId: string; billNumber: string; total: string; voided?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setErr(null);
    if (warning) { setWarning(null); router.refresh(); }
  }

  function submit() {
    setErr(null);
    start(async () => {
      const r = await voidRetailBill(billId);
      if (!r.ok) { setErr(r.error ?? "Failed"); return; }
      if (r.warning) { setWarning(r.warning); return; }
      setOpen(false);
      router.refresh();
    });
  }

  if (voided && !open) return null;

  return (
    <>
      {!voided && (
        <button
          type="button"
          onClick={() => { setErr(null); setOpen(true); }}
          className="font-body uppercase"
          style={{ fontSize: 11, letterSpacing: "0.1em", color: palette.crimsonText, minHeight: 44, padding: "0 10px", marginLeft: 8 }}
          title={`Void ${billNumber} — stock comes back, the bill stays on record as voided`}
        >
          Void
        </button>
      )}
      {open && (warning ? (
        <ConfirmSheet title={`${billNumber} voided`} confirmLabel="OK" tone="plain" cancelLabel={null} onConfirm={close} onClose={close}>
          {warning}
        </ConfirmSheet>
      ) : (
        <ConfirmSheet
          title={`Void ${billNumber}`}
          confirmLabel="Void bill"
          pendingLabel="Voiding…"
          pending={pending}
          error={err}
          onConfirm={submit}
          onClose={close}
        >
          Void {billNumber} ({total})? Stock comes back to the shelf; the bill stays on record as voided.
        </ConfirmSheet>
      ))}
    </>
  );
}

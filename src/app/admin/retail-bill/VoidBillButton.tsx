"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { palette } from "@/lib/palette";
import { voidRetailBill } from "./actions";

/** Void with an explicit two-tap confirm — stock returns, the row stays flagged. */
export function VoidBillButton({ billId, billNumber }: { billId: string; billNumber: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [arm, setArm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!arm) {
    return (
      <button type="button" onClick={() => { setArm(true); setTimeout(() => setArm(false), 4000); }} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.1em", color: palette.mutedGreige }}>
        Void
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {err && <span className="font-body" style={{ fontSize: 9, color: "#9C3A31" }}>{err}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => {
          const r = await voidRetailBill(billId);
          if (!r.ok) { setErr(r.error ?? "Failed"); return; }
          router.refresh();
        })}
        className="font-body uppercase disabled:opacity-40"
        style={{ fontSize: 8.5, letterSpacing: "0.1em", background: "#9C3A31", color: "#fff", padding: "4px 8px" }}
        title={`Void ${billNumber} — stock comes back, the bill stays on record as voided`}
      >
        Void {billNumber}?
      </button>
    </span>
  );
}

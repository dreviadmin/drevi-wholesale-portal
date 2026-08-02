"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { setOrderLineHsn } from "@/app/admin/orders/actions";
import { HsnInput } from "@/components/admin/HsnInput";
import { palette } from "@/lib/palette";

// Ansh (31 Jul) — HSN add/modify directly on a placed order's line. Saving
// also fills the product's HSN when the product has none, so the code joins
// the dropdown everywhere.
export function LineHsnEditor({
  orderId,
  index,
  hsn,
  options,
}: {
  orderId: string;
  index: number;
  hsn: string | null;
  options: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(hsn ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    start(async () => {
      setError(null);
      const res = await setOrderLineHsn(orderId, index, value);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 font-body uppercase align-middle ml-1.5"
        style={{ fontSize: 8, letterSpacing: "0.1em", color: palette.goldDeep }}
        aria-label="Edit HSN"
      >
        {hsn ? `HSN ${hsn}` : "+ HSN"} <Pencil size={9} />
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 ml-1.5 align-middle">
      <HsnInput value={value} onChange={setValue} options={options} style={{ width: 76, fontSize: 11, padding: "2px 2px" }} />
      <button type="button" disabled={pending} onClick={save} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8, letterSpacing: "0.1em", background: palette.black, color: palette.ivory, padding: "4px 8px" }}>
        Save
      </button>
      <button type="button" onClick={() => { setOpen(false); setValue(hsn ?? ""); }} className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.1em", color: palette.mutedGreige }}>
        Cancel
      </button>
      {error && <span className="font-body" style={{ fontSize: 8.5, color: palette.crimsonText }}>{error}</span>}
    </span>
  );
}

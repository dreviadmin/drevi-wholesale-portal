"use client";

import { useState } from "react";
import { ScanLine } from "lucide-react";
import { palette } from "@/lib/palette";
import { t } from "@/lib/strings";
import { ScanSheet } from "@/components/shell/ScanSheet";

// The cockpit's primary quick action — same sheet as the shell FAB.
export function HomeScanButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 font-body uppercase"
        style={{ fontSize: 10.5, letterSpacing: "0.18em", padding: "10px 16px", background: palette.gold, color: palette.black, fontWeight: 600 }}
      >
        <ScanLine size={14} strokeWidth={2.2} /> {t("home.action.scan")}
      </button>
      {open && <ScanSheet onClose={() => setOpen(false)} />}
    </>
  );
}

"use client";

import { useState } from "react";
import { ScanLine } from "lucide-react";
import { palette } from "@/lib/palette";
import { t } from "@/lib/strings";
import { ScanSheet } from "@/components/shell/ScanSheet";

// The cockpit's primary quick action — same sheet as the shell FAB. The
// prototype renders it as a full-width gold row heading the quick actions.
export function HomeScanButton({ fullWidth = false }: { fullWidth?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-2 font-body uppercase ${fullWidth ? "w-full justify-center" : ""}`}
        style={{ fontSize: 10.5, letterSpacing: "0.18em", padding: fullWidth ? "13px 16px" : "10px 16px", background: palette.gold, color: palette.black, fontWeight: 600 }}
      >
        <ScanLine size={15} strokeWidth={2.2} /> {fullWidth ? "Scan a tag" : t("home.action.scan")}
      </button>
      {open && <ScanSheet onClose={() => setOpen(false)} />}
    </>
  );
}

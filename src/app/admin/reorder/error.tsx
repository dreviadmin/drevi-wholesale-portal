"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { palette } from "@/lib/palette";

// The loader now throws on a failed read rather than showing an empty page,
// because a blank dashboard reads as "no sales".
export default function DashboardError({ reset }: { reset: () => void }) {
  const router = useRouter();
  const [, start] = useTransition();
  return (
    <div className="px-4 md:px-6 py-8 max-w-xl">
      <h1 className="font-display" style={{ fontSize: 20, fontWeight: 600, color: palette.black }}>The numbers did not load</h1>
      <p className="font-body mt-2" style={{ fontSize: 13, color: palette.softBlack }}>Nothing has changed. Check your connection and try again.</p>
      <button type="button" onClick={() => start(() => { router.refresh(); reset(); })} className="font-body uppercase mt-4" style={{ fontSize: 10, letterSpacing: "0.15em", padding: "9px 16px", background: palette.black, color: palette.ivory }}>
        Try again
      </button>
    </div>
  );
}

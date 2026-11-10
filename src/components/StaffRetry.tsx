"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { palette } from "@/lib/palette";

// What the admin layout shows when it could not check who is signed in (a
// failed staff_users read or an unreachable auth server). It used to send the
// person to /login, which signed nobody out but looked exactly as if it had.
// No shell: the page's own gate throws on the same failed lookup, so nothing
// under /admin shows until the check works.
export function StaffRetry() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: palette.pageBg }}>
      <div className="w-full max-w-sm text-center">
        <div className="font-display" style={{ fontSize: 16, letterSpacing: "0.3em", color: palette.black, fontWeight: 600 }}>DREVI</div>
        <h1 className="font-display mt-6" style={{ fontSize: 20, fontWeight: 600, color: palette.black }}>Could not reach the server</h1>
        <p className="font-body mt-2" style={{ fontSize: 13, lineHeight: 1.6, color: palette.softBlack }}>
          You are still signed in. Check your connection and try again.
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => start(() => router.refresh())}
          className="font-body uppercase mt-5 w-full disabled:opacity-60"
          style={{ fontSize: 11, letterSpacing: "0.15em", minHeight: 44, padding: "12px 16px", background: palette.black, color: palette.ivory }}
        >
          {pending ? "Trying…" : "Try again"}
        </button>
      </div>
    </div>
  );
}

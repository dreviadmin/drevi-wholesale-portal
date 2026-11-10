"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { palette } from "@/lib/palette";

// Any /admin page that throws lands here, inside the shell, so the tabs stay
// and staff can move on. That includes the page gates when the sign-in check
// itself failed (src/lib/staff.ts). Dashboard and Reorder keep their own
// error.tsx, which wins on their routes.
export default function AdminError({ reset }: { reset: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="px-4 md:px-6 py-8 max-w-xl">
      <h1 className="font-display" style={{ fontSize: 20, fontWeight: 600, color: palette.black }}>Something went wrong on this page</h1>
      <p className="font-body mt-2" style={{ fontSize: 13, lineHeight: 1.6, color: palette.softBlack }}>
        Nothing has changed, and you are still signed in. Check your connection and try again.
      </p>
      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button
          type="button"
          disabled={pending}
          onClick={() => start(() => { router.refresh(); reset(); })}
          className="font-body uppercase disabled:opacity-60"
          style={{ fontSize: 11, letterSpacing: "0.15em", minHeight: 44, padding: "12px 18px", background: palette.black, color: palette.ivory }}
        >
          {pending ? "Trying…" : "Try again"}
        </button>
        <Link
          href="/admin/home"
          className="font-body uppercase inline-flex items-center"
          style={{ fontSize: 11, letterSpacing: "0.15em", minHeight: 44, padding: "12px 18px", border: "1px solid rgba(26,26,26,0.2)", color: palette.softBlack }}
        >
          Go to Home
        </Link>
      </div>
    </div>
  );
}

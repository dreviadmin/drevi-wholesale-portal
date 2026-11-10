"use client";

import Link from "next/link";
import { palette } from "@/lib/palette";

// The way back from a buyer page that threw or hit notFound(). Next's own
// error and 404 screens have no link anywhere, so a buyer on a phone was left
// on a dead page. Every buyer segment's error.tsx / not-found.tsx renders
// this: home first, then log in, for a session that has lapsed. Same card as
// the one-tap page's (go/[token]/error.tsx).
export function BuyerFallback({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const solid = { background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" };
  const outlined = { border: `1px solid ${palette.black}`, color: palette.black, fontSize: 11, letterSpacing: "0.2em", padding: "12px 0" };
  return (
    <main className="min-h-screen flex items-center justify-center px-6" style={{ background: palette.pageBg }}>
      <div className="w-full max-w-sm text-center" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)", padding: 28 }}>
        <div className="font-display" style={{ fontSize: 16, letterSpacing: "0.35em", color: palette.black, fontWeight: 600 }}>DREVI</div>
        <p className="font-body mt-4" style={{ fontSize: 13, color: palette.softBlack, lineHeight: 1.6 }}>
          {message}
        </p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="block w-full mt-5 font-body uppercase" style={solid}>
            Try again
          </button>
        )}
        <Link href="/home" className={`block w-full ${onRetry ? "mt-3" : "mt-5"} font-body uppercase`} style={onRetry ? outlined : solid}>
          Back to home
        </Link>
        <Link href="/login" className="inline-block mt-4 font-body" style={{ fontSize: 11, color: palette.mutedGreige, textDecoration: "underline" }}>
          Log in again
        </Link>
      </div>
    </main>
  );
}

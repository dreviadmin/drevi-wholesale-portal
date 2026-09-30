"use client";

import Link from "next/link";
import { palette } from "@/lib/palette";
import { WHOLESALE_PHONE } from "@/lib/contact";

// Anything that throws on the one-tap page must still leave the buyer a way
// in — without this, Next's bare error screen has no link anywhere.
export default function GoError() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6" style={{ background: palette.pageBg }}>
      <div className="w-full max-w-sm text-center" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)", padding: 28 }}>
        <p className="font-body" style={{ fontSize: 13, color: palette.softBlack, lineHeight: 1.6 }}>
          We couldn&apos;t open your account from this link. Log in with your username and password, or call Rakesh on {WHOLESALE_PHONE}.
        </p>
        <Link
          href="/login"
          className="block w-full mt-5 font-body uppercase"
          style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
        >
          Log in with password
        </Link>
      </div>
    </main>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { palette } from "@/lib/palette";

const RAKESH_PHONE = "+91 88280 43555";
const RAKESH_WA = "918828043555";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");

  // Credentials are managed by Rakesh (there is no self-serve reset), so this
  // page routes the buyer to him with a pre-filled WhatsApp message rather than
  // sending a reset link that lands nowhere.
  const waHref = `https://wa.me/${RAKESH_WA}?text=${encodeURIComponent(
    `Hi Rakesh, please reset my Drevi wholesale portal password${email.trim() ? ` for ${email.trim()}` : ""}.`,
  )}`;

  return (
    <main className="min-h-screen flex items-center justify-center px-6" style={{ background: palette.pageBg }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-display" style={{ fontSize: 30, letterSpacing: "0.35em", color: palette.black, fontWeight: 600 }}>
            DREVI
          </div>
          <div className="font-body mt-2" style={{ fontSize: 10, letterSpacing: "0.25em", color: palette.mutedGreige, textTransform: "uppercase" }}>
            Reset Password
          </div>
        </div>

        <div style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)", padding: 28 }}>
          <p className="font-body" style={{ fontSize: 12, color: palette.softBlack, lineHeight: 1.7 }}>
            Your login is managed by the Drevi team. Enter your email and tap below to message Rakesh on
            WhatsApp ({RAKESH_PHONE}) — he&apos;ll reset your password and send it back.
          </p>
          <label className="flex flex-col gap-1.5 mt-4">
            <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>
              Email
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="font-body bg-transparent outline-none"
              style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "8px 2px", fontSize: 14, color: palette.black }}
            />
          </label>
          <a
            href={waHref}
            target="_blank"
            rel="noopener"
            className="w-full font-body uppercase mt-4 transition-opacity block text-center"
            style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
          >
            Message Rakesh on WhatsApp
          </a>

          <Link
            href="/login"
            className="font-body uppercase block text-center mt-5"
            style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}
          >
            Back to Sign In
          </Link>
        </div>
      </div>
    </main>
  );
}

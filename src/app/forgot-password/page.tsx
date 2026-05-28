"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { palette } from "@/lib/palette";

const RAKESH_PHONE = "+91 88280 43555";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const supabase = createClient();
    // Errors are swallowed deliberately — never reveal whether an email exists.
    await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase());
    setSent(true);
    setBusy(false);
  }

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
          {sent ? (
            <p className="font-body" style={{ fontSize: 12, color: palette.softBlack, lineHeight: 1.7 }}>
              If an account exists for that email, a reset link is on its way. You can also message Rakesh on
              WhatsApp ({RAKESH_PHONE}) and he&apos;ll resend your credentials.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>
                  Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="font-body bg-transparent outline-none"
                  style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "8px 2px", fontSize: 14, color: palette.black }}
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full font-body uppercase mt-2 transition-opacity disabled:opacity-60"
                style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
              >
                {busy ? "Sending…" : "Send Reset Link"}
              </button>
            </form>
          )}

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

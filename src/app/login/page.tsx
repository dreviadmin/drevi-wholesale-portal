"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { login, type LoginState } from "./actions";
import { palette } from "@/lib/palette";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full font-body uppercase mt-2 transition-opacity disabled:opacity-60"
      style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
    >
      {pending ? "Signing in…" : "Sign In"}
    </button>
  );
}

export default function LoginPage() {
  const [state, formAction] = useFormState<LoginState, FormData>(login, {});
  const [showPw, setShowPw] = useState(false);

  return (
    <main className="min-h-screen flex items-center justify-center px-6" style={{ background: palette.pageBg }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-display" style={{ fontSize: 30, letterSpacing: "0.35em", color: palette.black, fontWeight: 600 }}>
            DREVI
          </div>
          <div className="font-body mt-2" style={{ fontSize: 10, letterSpacing: "0.25em", color: palette.mutedGreige, textTransform: "uppercase" }}>
            Wholesale Portal
          </div>
        </div>

        <form action={formAction} className="flex flex-col gap-4" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)", padding: 28 }}>
          <label className="flex flex-col gap-1.5">
            <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>
              Email
            </span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              className="font-body bg-transparent outline-none"
              style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "8px 2px", fontSize: 14, color: palette.black }}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>
              Password
            </span>
            <div className="flex items-center gap-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)" }}>
              <input
                type={showPw ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                required
                className="font-body bg-transparent outline-none flex-1"
                style={{ padding: "8px 2px", fontSize: 14, color: palette.black }}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "Hide password" : "Show password"}
                className="pr-1"
                style={{ color: palette.mutedGreige }}
              >
                {showPw ? <EyeOff size={16} strokeWidth={1.7} /> : <Eye size={16} strokeWidth={1.7} />}
              </button>
            </div>
          </label>

          {state?.error && (
            <p className="font-body" style={{ color: palette.crimsonText, fontSize: 11, letterSpacing: "0.02em", lineHeight: 1.5 }}>
              {state.error}
            </p>
          )}

          <SubmitButton />

          <Link
            href="/forgot-password"
            className="font-body uppercase text-center mt-1"
            style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}
          >
            Forgot Password
          </Link>
        </form>
      </div>
    </main>
  );
}

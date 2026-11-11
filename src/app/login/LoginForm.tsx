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

export function LoginForm() {
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
          {/* The hint sits outside the <label> so it is the field's
              description, not part of its name. */}
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em", color: palette.softBlack }}>
                Username or Email
              </span>
              {/* type=text (not email): buyers sign in with a bare username (the
                  first word of their business name) and staff with just their
                  name. The server resolves a bare id lookup-first — staff domain
                  when staff_users knows it, else the synthetic buyer domain —
                  and full emails pass through as-is. */}
              <input
                type="text"
                name="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                required
                aria-describedby="login-username-hint"
                className="font-body bg-transparent outline-none"
                style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "8px 2px", fontSize: 16, color: palette.black }}
              />
            </label>
            <span id="login-username-hint" className="font-body" style={{ fontSize: 11, color: palette.mutedGreige, lineHeight: 1.5 }}>
              The one-word username in Rakesh&apos;s WhatsApp message
            </span>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em", color: palette.softBlack }}>
              Password
            </span>
            <div className="flex items-center gap-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)" }}>
              <input
                type={showPw ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                required
                className="font-body bg-transparent outline-none flex-1"
                style={{ padding: "8px 2px", fontSize: 16, color: palette.black }}
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
            className="font-body uppercase flex items-center justify-center"
            style={{ minHeight: 44, fontSize: 11, letterSpacing: "0.18em", color: palette.mutedGreige }}
          >
            Forgot Password
          </Link>

          {/* /wholesale is public (middleware) and is the request-access form;
              nothing linked to it, so a new buyer landing here had no way in. */}
          <Link
            href="/wholesale"
            className="font-body flex items-center justify-center"
            style={{ minHeight: 44, fontSize: 13, color: palette.softBlack, borderTop: "1px solid rgba(26,26,26,0.08)" }}
          >
            New buyer?&nbsp;<span style={{ color: palette.goldDeep, textDecoration: "underline" }}>Request access</span>
          </Link>
        </form>
      </div>
    </main>
  );
}

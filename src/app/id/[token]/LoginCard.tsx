"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Copy, Check } from "lucide-react";
import { continueWithLink } from "@/app/go/[token]/actions";
import { palette } from "@/lib/palette";

function OpenButton({ business }: { business: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full font-body uppercase transition-opacity disabled:opacity-60"
      style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
    >
      {pending ? "Opening…" : `Open ${business}'s account`}
    </button>
  );
}

function Row({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    let ok = false;
    try { await navigator.clipboard.writeText(value); ok = true; } catch { /* fallback below */ }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = value; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    }
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  }
  return (
    <div className="flex items-center justify-between gap-3 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
      <div className="min-w-0">
        <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>{label}</div>
        <div className="font-body mt-0.5" style={{ fontSize: 16, fontWeight: 600, color: palette.black, wordBreak: "break-all" }}>{value}</div>
      </div>
      {copyable && (
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="flex items-center gap-1 font-body uppercase shrink-0"
          style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 9, letterSpacing: "0.15em", padding: "6px 10px" }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

/**
 * The buyer's own login, as Rakesh's greeting video promises — plus the
 * one-tap sign-in, so reading it and getting in are the same visit.
 */
export function LoginCard({
  token,
  business,
  site,
  username,
  password,
  signedIn,
}: {
  token: string;
  business: string;
  site: string;
  username: { label: string; value: string };
  password: string | null;
  signedIn: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Your login</div>
        <h1 className="font-display mt-1" style={{ fontSize: 18, fontWeight: 600, color: palette.black }}>{business}</h1>
      </div>
      <div>
        <Row label="Link" value={site} />
        <Row label={username.label} value={username.value} copyable />
        {password ? (
          <Row label="Password" value={password} copyable />
        ) : (
          <p className="font-body py-2.5" style={{ fontSize: 12, color: palette.softBlack }}>
            Password not available here — ask Rakesh on WhatsApp.
          </p>
        )}
      </div>
      <p className="font-body" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6 }}>
        इन्हें save कर लीजिए — किसी भी phone या laptop से login कर सकते हैं।
      </p>
      {signedIn ? (
        <Link
          href="/home"
          className="w-full text-center font-body uppercase"
          style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
        >
          Go to catalog
        </Link>
      ) : (
        <form action={continueWithLink}>
          <input type="hidden" name="token" value={token} />
          <OpenButton business={business} />
        </form>
      )}
    </div>
  );
}

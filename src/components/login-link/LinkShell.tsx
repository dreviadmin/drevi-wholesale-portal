import type { Metadata } from "next";
import Link from "next/link";
import { WHOLESALE_PHONE, WHOLESALE_PHONE_DIGITS } from "@/lib/contact";
import { palette } from "@/lib/palette";

// Shared frame for the two pages a WhatsApp login button opens (0073):
// /go/<token> signs the buyer in, /id/<token> shows their username and
// password. Both are keyed by the same token and refuse the same way.

// The token is a login. Keep it out of search indexes and out of the Referer
// header of anything these pages link to.
export const LINK_PAGE_METADATA: Metadata = {
  title: "Drevi Wholesale",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const REFUSAL_COPY: Record<string, { title: string; body: string }> = {
  unknown: {
    title: "This link doesn't work any more",
    body: "Ask Rakesh on WhatsApp for a new one, or log in with your username and password.",
  },
  revoked: {
    title: "This link doesn't work any more",
    body: "Ask Rakesh on WhatsApp for a new one, or log in with your username and password.",
  },
  inactive: {
    title: "Your account is inactive",
    body: `Please contact Rakesh: ${WHOLESALE_PHONE}.`,
  },
  no_login: {
    title: "This account isn't ready yet",
    body: `Please contact Rakesh: ${WHOLESALE_PHONE}.`,
  },
  staff: {
    title: "This link can't be used",
    body: `Please contact Rakesh: ${WHOLESALE_PHONE}.`,
  },
  error: {
    title: "Something went wrong",
    body: "Please try the link again in a moment, or log in with your username and password.",
  },
};

export function LinkShell({ children }: { children: React.ReactNode }) {
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
        <div style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)", padding: 28 }}>{children}</div>
      </div>
    </main>
  );
}

export function LinkRefusal({ reason }: { reason: string }) {
  const copy = REFUSAL_COPY[reason] ?? REFUSAL_COPY.unknown;
  return (
    <LinkShell>
      <h1 className="font-display" style={{ fontSize: 18, fontWeight: 600, color: palette.black }}>{copy.title}</h1>
      <p className="font-body mt-3" style={{ fontSize: 13, color: palette.softBlack, lineHeight: 1.6 }}>{copy.body}</p>
      <div className="flex flex-col gap-3 mt-5">
        <a
          href={`https://wa.me/${WHOLESALE_PHONE_DIGITS}`}
          className="w-full text-center font-body uppercase"
          style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
        >
          WhatsApp Rakesh
        </a>
        <Link
          href="/login"
          className="font-body uppercase text-center"
          style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}
        >
          Log in with password
        </Link>
      </div>
    </LinkShell>
  );
}

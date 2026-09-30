import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { resolveLoginToken } from "@/lib/login-link";
import { loginDisplay } from "@/lib/share";
import { WHOLESALE_PHONE, WHOLESALE_PHONE_DIGITS } from "@/lib/contact";
import { palette } from "@/lib/palette";
import { GoForm } from "./GoForm";

export const dynamic = "force-dynamic";

// The token is a login. Keep it out of search indexes and out of the Referer
// header of anything this page links to.
export const metadata: Metadata = {
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

function Shell({ children }: { children: React.ReactNode }) {
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

export default async function GoPage({ params, searchParams }: { params: { token: string }; searchParams: { e?: string } }) {
  const resolved = await resolveLoginToken(params.token);

  if (!resolved.ok) {
    const copy = REFUSAL_COPY[resolved.reason] ?? REFUSAL_COPY.unknown;
    return (
      <Shell>
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
      </Shell>
    );
  }

  const failed = searchParams.e === "1";
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const current = user?.email?.toLowerCase() ?? null;

  // Already in as this buyer (the second tap on the same message, or a double
  // submit whose other half won) — straight in, even from the ?e=1 page.
  if (current && current === resolved.buyer.email.toLowerCase()) redirect("/home");

  const business = resolved.buyer.business_name?.trim() || loginDisplay(resolved.buyer.email).value;
  return (
    <Shell>
      <GoForm
        token={params.token}
        business={business}
        otherSession={current && current !== resolved.buyer.email.toLowerCase() ? loginDisplay(current).value : null}
        failed={failed}
      />
    </Shell>
  );
}

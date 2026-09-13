import type { Metadata } from "next";
import { palette } from "@/lib/palette";

// The offline fallback (Ansh, 13 Sep). next-pwa auto-detects app/~offline/page
// and precaches it, then serves it from `handlerDidError` whenever a handler
// fails for want of a network — which for this portal means any navigation,
// because navigations are NetworkOnly by design (see next.config.mjs).
//
// Deliberately static and dependency-free: no auth, no Supabase, no data. It
// has to render from the precache with no network and no session, so anything
// it touched at request time would defeat the point.
export const metadata: Metadata = {
  title: "Offline · Drevi Wholesale",
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <main
      className="flex flex-col items-center justify-center text-center px-8"
      style={{ minHeight: "100dvh", background: palette.black }}
    >
      <div
        className="font-display"
        style={{ fontSize: 30, fontWeight: 600, letterSpacing: "0.35em", color: palette.gold, textIndent: "0.35em" }}
      >
        DREVI
      </div>
      <div
        className="font-body"
        style={{ marginTop: 10, fontSize: 9, letterSpacing: "0.3em", color: palette.mutedGreige, textIndent: "0.3em" }}
      >
        WHOLESALE PORTAL
      </div>

      <div
        aria-hidden
        style={{ width: 34, height: 1, background: palette.goldDeep, opacity: 0.55, margin: "34px 0" }}
      />

      <h1 className="font-display" style={{ fontSize: 20, fontWeight: 500, color: palette.ivory }}>
        You&rsquo;re offline.
      </h1>
      <p
        className="font-body"
        style={{ marginTop: 12, fontSize: 12, lineHeight: 1.9, color: palette.mutedGreige, maxWidth: 300 }}
      >
        This page needs a connection. Your saved drafts are untouched — reconnect
        and carry on where you left off.
      </p>
    </main>
  );
}

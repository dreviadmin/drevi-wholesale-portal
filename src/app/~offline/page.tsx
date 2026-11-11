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
        style={{ marginTop: 12, fontSize: 13, lineHeight: 1.9, color: palette.mutedGreige, maxWidth: 300 }}
      >
        Check your internet connection and tap Try again. Nothing you have
        already saved is lost.
      </p>

      {/* Plain anchors, no JavaScript: the installed app has no browser
          chrome, so without these the page was a dead end. href="" reloads
          the URL this fallback was served for (the page the user was trying
          to open); "/" sends staff to /admin and buyers to /home. A full
          document load is the point, so these are deliberately not <Link>. */}
      <div className="flex flex-wrap items-center justify-center gap-3" style={{ marginTop: 28 }}>
        <a
          href=""
          className="font-body uppercase flex items-center justify-center"
          style={{ minHeight: 44, padding: "0 22px", background: palette.gold, color: palette.black, fontSize: 11, letterSpacing: "0.2em" }}
        >
          Try again
        </a>
        <a
          href="/"
          className="font-body uppercase flex items-center justify-center"
          style={{ minHeight: 44, padding: "0 22px", border: `1px solid ${palette.goldDeep}`, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em" }}
        >
          Home
        </a>
      </div>
    </main>
  );
}

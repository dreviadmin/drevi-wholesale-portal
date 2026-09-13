"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Share, SquarePlus, X, Download } from "lucide-react";
import { palette } from "@/lib/palette";

// First-visit "install this as an app" banner (Ansh, 13 Sep).
//
// Two entirely different mechanisms, because there is no single one:
//   Chrome/Edge (desktop + Android) fire `beforeinstallprompt`. We capture it,
//     suppress the browser's own mini-infobar, and drive it from our button.
//   iOS Safari never fires it and exposes no install API at all — the only
//     route is Share -> Add to Home Screen, so iOS gets an instruction card.
//
// Trade-off worth knowing: calling preventDefault() is what lets us show our
// own banner, and it also suppresses Chrome's native prompt. You get one or
// the other, not both.
//
// Shows once. Dismissing or installing writes a flag and it never returns.

const SEEN_KEY = "drevi:install-prompt:v1";

// /login ONLY, and that is a considered choice rather than a limitation.
//
// This banner is fixed and bottom-anchored, and bottom is where this codebase
// puts everything that matters: AppShell's mobile tab bar and Scan FAB
// (`fixed bottom-0 ... z-40`), the Save / Save & print tags bar in
// admin/receipts/new (`fixed bottom-0`, no z-index at all), the Studio board
// bar (z-40), the /home scan FAB, and every toast in the app (z-50). An
// adversarial review found the banner covering the admin tab bar and FAB,
// painting over the scan sheet and the QR scanner, and hiding add-to-cart
// toasts. Those were fixable with per-route pixel offsets, but offsets
// hand-tuned to another component's current height rot silently the moment
// that component changes.
//
// /login has no bottom-anchored UI whatsoever, and it is genuinely the first
// screen the site shows. Trade-off, stated plainly: a device that stays signed
// in forever never sees this. Putting it on a signed-in landing screen wants a
// real slot in AppShell, not a floating overlay.
const LANDING_ROUTES = new Set(["/login"]);

// The banner is ~125px tall and the login form is vertically centred, so on a
// short viewport the two collide and the card — which owns its pointer events
// — sits on top of the password field. Measured: at 317px tall the field is
// unreachable. A phone in landscape is ~390px, so this is not a corner case.
// Below this height the banner simply does not appear; installing is still
// available from the browser's own menu.
const MIN_VIEWPORT_HEIGHT = 680;

type Mode = "none" | "prompt" | "ios";

interface BIPEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function alreadySeen(): boolean {
  try {
    return !!localStorage.getItem(SEEN_KEY);
  } catch {
    return false; // private mode — show it, just don't remember
  }
}

function remember(v: string) {
  try {
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    /* storage blocked — nothing to do */
  }
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as MacIntel with touch points.
  return /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function InstallPrompt() {
  const pathname = usePathname();
  const [mode, setMode] = useState<Mode>("none");
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  // Survives a blocked localStorage (private browsing), where alreadySeen()
  // cannot remember anything — the banner must still show only once per session.
  const handledRef = useRef(false);
  // Android sets viewport.interactiveWidget = "resizes-content" (layout.tsx),
  // so opening the keyboard shrinks the layout viewport and a bottom-anchored
  // fixed element re-anchors ABOVE the keyboard — landing squarely on the Sign
  // In button while the user is typing. Suppress whenever a field has focus.
  const [typing, setTyping] = useState(false);
  const [roomy, setRoomy] = useState(true);

  useEffect(() => {
    if (isStandalone() || alreadySeen()) return;

    const onBip = (e: Event) => {
      e.preventDefault(); // suppresses Chrome's own infobar; ours replaces it
      // Re-checked on every event, not just at mount: Chrome may fire this
      // again later in the same page session, which would otherwise bring the
      // banner back after the user had already dismissed or installed it.
      if (handledRef.current || alreadySeen()) return;
      setDeferred(e as BIPEvent);
      setMode("prompt");
    };
    window.addEventListener("beforeinstallprompt", onBip);

    // iOS has no event to wait for, so offer the instructions directly. Held
    // back a moment so it does not fight the first paint.
    let t: ReturnType<typeof setTimeout> | undefined;
    // WebKit fires no 'appinstalled' and the iOS card has no Install button,
    // so nothing would ever record that it had been shown — it would return on
    // every single visit. Showing it IS the event.
    if (isIOS())
      t = setTimeout(() => {
        if (handledRef.current) return;
        setMode((m) => {
          if (m !== "none") return m;
          handledRef.current = true;
          remember("ios-shown");
          return "ios";
        });
      }, 2500);

    const isField = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
    };
    const onFocusIn = (e: FocusEvent) => { if (isField(e.target)) setTyping(true); };
    const onFocusOut = (e: FocusEvent) => { if (isField(e.target)) setTyping(false); };
    const measure = () => setRoomy(window.innerHeight >= MIN_VIEWPORT_HEIGHT);
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    const onInstalled = () => {
      remember("installed");
      setMode("none");
    };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      if (t) clearTimeout(t);
    };
  }, []);

  // Never over the offline fallback — there is no network to install over.
  if (mode === "none" || typing || !roomy || !LANDING_ROUTES.has(pathname)) return null;

  const dismiss = () => {
    handledRef.current = true;
    remember("dismissed");
    setMode("none");
  };

  const install = async () => {
    if (!deferred) return;
    handledRef.current = true;
    remember("installed");
    setMode("none");
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* the event can only be used once; nothing useful to recover */
    }
  };

  return (
    <div
      role="region"
      aria-label="Install the Drevi Wholesale app"
      className="fixed left-0 right-0 z-40 px-3 pointer-events-none"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
    >
      <div
        className="mx-auto flex items-start gap-3 px-4 py-3.5 pointer-events-auto"
        style={{
          maxWidth: 460,
          background: palette.ivory,
          border: `1px solid ${palette.gold}`,
          boxShadow: "0 14px 40px rgba(26,26,26,0.22)",
        }}
      >
        <div
          className="flex items-center justify-center shrink-0"
          style={{ width: 34, height: 34, background: palette.black }}
          aria-hidden
        >
          {mode === "ios" ? (
            <Share size={16} color={palette.gold} strokeWidth={1.7} />
          ) : (
            <Download size={16} color={palette.gold} strokeWidth={1.7} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div
            className="font-body uppercase"
            style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.goldDeep }}
          >
            Drevi Wholesale
          </div>

          {mode === "ios" ? (
            <p className="font-body" style={{ marginTop: 3, fontSize: 12, lineHeight: 1.65, color: palette.softBlack }}>
              Tap <Share size={12} strokeWidth={1.9} style={{ display: "inline", verticalAlign: "-1px" }} /> Share,
              then <SquarePlus size={12} strokeWidth={1.9} style={{ display: "inline", verticalAlign: "-1px" }} /> Add
              to Home Screen, to open the portal as an app.
            </p>
          ) : (
            <p className="font-body" style={{ marginTop: 3, fontSize: 12, lineHeight: 1.65, color: palette.softBlack }}>
              Install the portal as an app — it opens in its own window and works on a weak connection.
            </p>
          )}

          {mode === "prompt" && (
            <button
              type="button"
              onClick={install}
              className="font-body uppercase"
              style={{
                marginTop: 10,
                padding: "7px 18px",
                fontSize: 10,
                letterSpacing: "0.16em",
                color: palette.ivory,
                background: palette.black,
              }}
            >
              Install
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0"
          style={{ color: palette.mutedGreige, padding: 2, marginTop: -2 }}
        >
          <X size={16} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}

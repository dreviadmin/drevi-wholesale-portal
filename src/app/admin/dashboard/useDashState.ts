"use client";

import { useCallback, useMemo, useRef, useTransition } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { withFrom } from "@/components/BackLink";
import { parseDashState, serializeDashState, type DashState, type View } from "@/lib/dashboard/state";

export interface Nav {
  state: DashState;
  here: string; // this exact view, for onward links to come back to
  busy: boolean;
  hrefFor: (next: DashState) => string;
  /** Tabs, chips and sort: changes the view without adding a Back step. */
  go: (next: DashState) => void;
  /** A filter change: one Back step per tap, and the results scroll into view. */
  open: (next: DashState, opts?: { scroll?: boolean }) => void;
  /** Retraces the last filter tap, or runs `fallback` on a page opened from a link. */
  back: (fallback: () => void) => void;
  onward: (href: string) => string;
  /** Set by open(), read once by the page after the change lands. */
  justOpened: React.MutableRefObject<boolean>;
}

/** How many filter taps this history entry sits on top of. */
const historyDepth = () => Number(window.history.state?.dashDepth) || 0;

// The URL is the only copy of this state. history.pushState stays inside the
// router, so nothing refetches: every tap is worked out from what is on screen.
export function useDashState(defaultView: View): Nav {
  const pathname = usePathname();
  const params = useSearchParams();
  const state = useMemo(() => parseDashState(params, defaultView), [params, defaultView]);
  const [busy, startTransition] = useTransition();
  const justOpened = useRef(false);

  const hrefFor = useCallback((next: DashState) => `${pathname}?${serializeDashState(next)}`, [pathname]);
  const here = hrefFor(state);

  const write = useCallback((next: DashState, method: "pushState" | "replaceState") => {
    const url = hrefFor(next);
    // The live address, not `here`: a second tap can land before the first paints.
    // Read through the parser, because the bare address means the same as its defaults.
    if (url === hrefFor(parseDashState(new URLSearchParams(window.location.search), defaultView))) return false;
    // Our own field only. Passing history.state through would skip the router's sync.
    const data = { dashDepth: historyDepth() + (method === "pushState" ? 1 : 0) };
    startTransition(() => window.history[method](data, "", url));
    return true;
  }, [hrefFor, defaultView]);

  const go = useCallback((next: DashState) => { write(next, "replaceState"); }, [write]);
  const open = useCallback((next: DashState, opts?: { scroll?: boolean }) => {
    if (write(next, "pushState") && opts?.scroll !== false) justOpened.current = true;
  }, [write]);
  const back = useCallback((fallback: () => void) => {
    if (historyDepth() > 0) window.history.back();
    else fallback();
  }, []);
  const onward = useCallback((href: string) => withFrom(href, here), [here]);

  return { state, here, busy, hrefFor, go, open, back, onward, justOpened };
}

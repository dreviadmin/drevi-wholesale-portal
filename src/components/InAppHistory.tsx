"use client";

import { useCallback, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { canGoBackInApp, nextDepth } from "@/lib/back-nav";

// How many of this app's pages sit behind the current one, for Back buttons
// that must not leave the portal (see src/lib/back-nav.ts). Module state, not
// React state: it lives as long as this tab's JS does, across client-side
// navigations, and a full reload starts it again at zero, which only ever
// sends Back to the page's fallback.
let depth = 0;
let lastPath: string | null = null;
// The path a popstate went to. A popstate that keeps the path (a query-only
// entry) never reaches the pathname effect, so a bare flag would linger and
// mark the next ordinary link as a Back.
let popPath: string | null = null;
let lastNavWasPop = false;

/**
 * Mounted once, in the root layout, ahead of the page: effects run in tree
 * order, so by the time a page's own mount effect runs, the navigation that
 * brought it there has been counted. Renders nothing.
 */
export function InAppHistory() {
  const pathname = usePathname();

  useEffect(() => {
    const onPop = () => { popPath = window.location.pathname; };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    // Compared by path, not by "first run", so React's dev double-run of
    // effects does not count as a navigation.
    if (lastPath === null) lastPath = pathname;
    else if (pathname !== lastPath) {
      const wasPop = popPath === pathname;
      depth = nextDepth(depth, wasPop);
      lastNavWasPop = wasPop;
      lastPath = pathname;
    }
    popPath = null;
  }, [pathname]);

  return null;
}

/**
 * Did the browser's Back/Forward bring this page up (rather than a link)? For
 * the catalog's scroll restore. Read it in a mount effect.
 */
export function arrivedByBackOrForward(): boolean {
  return lastNavWasPop;
}

/** Back that goes back when an in-app page is behind this one, else to `fallback`. */
export function useInAppBack(fallback: string): () => void {
  const router = useRouter();
  return useCallback(() => {
    const nav = (window as { navigation?: { currentEntry?: { index?: number } | null } }).navigation;
    if (canGoBackInApp(nav?.currentEntry?.index ?? null, depth)) router.back();
    else router.push(fallback);
  }, [router, fallback]);
}

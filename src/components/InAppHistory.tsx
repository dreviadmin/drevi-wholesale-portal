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
let popPending = false;

/** Mounted once, in the root layout. Renders nothing. */
export function InAppHistory() {
  const pathname = usePathname();

  useEffect(() => {
    const onPop = () => { popPending = true; };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    // Compared by path, not by "first run", so React's dev double-run of
    // effects does not count as a navigation.
    if (lastPath === null) lastPath = pathname;
    else if (pathname !== lastPath) {
      depth = nextDepth(depth, popPending);
      lastPath = pathname;
    }
    popPending = false;
  }, [pathname]);

  return null;
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

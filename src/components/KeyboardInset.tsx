"use client";

import { useEffect } from "react";

// iOS overlays the on-screen keyboard on top of the page without extending the
// scroll range, so Save buttons at the bottom of a form become unreachable.
// Track the visual viewport and expose the covered height as --kb-inset;
// globals.css pads the page bottom by it, and bottom-sheet modals pad their
// scroll containers. (Android resizes the viewport itself via the
// interactive-widget=resizes-content viewport flag, so the inset stays ~0.)
export function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Pinch zoom also shrinks the visual viewport — only a 1:1 scale
      // shrinkage means the keyboard is up.
      const zoomed = vv.scale != null && Math.abs(vv.scale - 1) > 0.01;
      const inset = zoomed ? 0 : Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--kb-inset", `${Math.round(inset)}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--kb-inset");
    };
  }, []);
  return null;
}

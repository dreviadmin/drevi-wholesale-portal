"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Next's client router caches visited dynamic routes for ~30s, so admin lists
// could look stale right after a mutation elsewhere. Rendering this in a page
// re-fetches its server data on every visit (and on tab re-focus).
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router]);
  return null;
}

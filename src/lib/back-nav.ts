// Buyer Back buttons (Oct review). router.back() is only right when the page
// behind this one is a page of this app: a product opened straight from a
// WhatsApp link, in a fresh tab or in the installed app has nothing behind it,
// and router.back() then does nothing or leaves the portal. Those cases get
// the page's own fallback instead.
//
// document.referrer cannot answer this: it is set once per full page load and
// never changes on the app router's client-side navigations, so in the
// installed app (no referrer at launch) it would send every Back to the
// fallback, even from catalog to product. Instead we count the in-app pages
// behind the current one (InAppHistory) and, where the browser has the
// Navigation API, ask it directly.

/** In-app pages behind the current one after a navigation. */
export function nextDepth(depth: number, wasPop: boolean): number {
  // Back and forward both arrive as popstate; on a phone it is almost always
  // Back. Treating a forward as a Back only ever errs towards the fallback.
  return wasPop ? Math.max(0, depth - 1) : depth + 1;
}

/**
 * Should Back call router.back()? `entryIndex` is the Navigation API's
 * currentEntry.index (same-origin entries only), null where the browser has no
 * Navigation API; `depth` is the count InAppHistory keeps.
 */
export function canGoBackInApp(entryIndex: number | null | undefined, depth: number): boolean {
  if (typeof entryIndex === "number") return entryIndex > 0;
  return depth > 0;
}

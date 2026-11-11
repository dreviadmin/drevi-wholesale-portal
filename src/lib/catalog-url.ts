// The buyer catalog keeps its filters in the URL (Oct review): category `cat`,
// sub-category `sub`, search `q`. Back from a product used to land on "All"
// at the top of the page because the filters lived only in React state. The
// /home "Shop by category" links already write /catalog?cat=…&sub=…, so they
// read the same way.

export interface CatalogFilters {
  category: string; // "All" for every category
  sub: string | null; // null = every design in the category
  query: string;
}

/** Filters from a URL's search params; a sub-category only counts under a category. */
export function catalogFiltersFrom(params: { get(name: string): string | null } | null | undefined): CatalogFilters {
  const category = params?.get("cat")?.trim() || "All";
  const sub = category !== "All" ? params?.get("sub")?.trim() || null : null;
  const query = params?.get("q") ?? "";
  return { category, sub, query };
}

/** The catalog URL for these filters; plain /catalog when nothing is set. */
export function catalogHref({ category, sub, query }: CatalogFilters): string {
  const params = new URLSearchParams();
  if (category && category !== "All") {
    params.set("cat", category);
    if (sub) params.set("sub", sub);
  }
  const q = query.trim();
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/catalog?${qs}` : "/catalog";
}

// Scroll position across a product visit: saved (sessionStorage, one slot) as
// the buyer opens a product, put back once on the way Back to the same URL.

/** What CatalogView saves when a card is opened. */
export function savedScroll(url: string, y: number): string {
  return JSON.stringify({ url, y: Math.max(0, Math.round(y)) });
}

/**
 * The scroll to put back, or null. Only on Back/Forward to the very URL it was
 * saved on: a fresh visit to the same filters starts at the top.
 */
export function scrollToRestore(raw: string | null, currentUrl: string, arrivedByBackOrForward: boolean): number | null {
  if (!raw || !arrivedByBackOrForward) return null;
  try {
    const v = JSON.parse(raw) as { url?: unknown; y?: unknown };
    if (v?.url !== currentUrl || typeof v.y !== "number" || !Number.isFinite(v.y) || v.y <= 0) return null;
    return v.y;
  } catch {
    return null;
  }
}

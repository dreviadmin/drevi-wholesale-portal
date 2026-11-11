// The design-row values the Shopify push reads (publishShopify in shopify.ts):
// fabric, handwork, origin and the colour name become the product's facts, and
// the MRP (override, else auto) and the compare-at become its price. A Product
// Master save that moves any of them on a live design changes what the shop
// would show, so it flips that target to changes_pending (D3). Pure, so the
// rule is pinned by vitest; it decides only whether to ask for a Re-push and
// never sends anything.

export type ShopifyFactKey = "fabric" | "handwork" | "origin" | "color_name" | "auto_mrp" | "mrp_override" | "compare_at_price";

/** A design row, or the patch a save writes. A key left out (or undefined) is not being written. */
export type ShopifyFacts = { [K in ShopifyFactKey]?: unknown };

const TEXT_KEYS = ["fabric", "handwork", "origin", "color_name"] as const;

// "" and null both mean "not set", the way the saves store them.
const text = (v: unknown): string | null => (v == null ? "" : String(v).trim()) || null;
// The push treats an MRP of 0 as unpriced, so 0, null and junk compare equal.
const money = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

/** The retail price the push sells at: the override, else the auto MRP. */
export function shopifyRetail(f: ShopifyFacts): number | null {
  return money(f.mrp_override) ?? money(f.auto_mrp);
}

/**
 * True when `after` changes something the Shopify push reads. The price is
 * compared as the push sees it, so a new auto MRP under an unchanged override
 * is not a change.
 */
export function shopifyFactsChanged(before: ShopifyFacts, after: ShopifyFacts): boolean {
  for (const k of TEXT_KEYS) {
    if (after[k] !== undefined && text(after[k]) !== text(before[k])) return true;
  }
  if (after.auto_mrp !== undefined || after.mrp_override !== undefined) {
    const next: ShopifyFacts = { ...before };
    if (after.auto_mrp !== undefined) next.auto_mrp = after.auto_mrp;
    if (after.mrp_override !== undefined) next.mrp_override = after.mrp_override;
    if (shopifyRetail(next) !== shopifyRetail(before)) return true;
  }
  if (after.compare_at_price !== undefined && money(after.compare_at_price) !== money(before.compare_at_price)) return true;
  return false;
}

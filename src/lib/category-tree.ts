import type { WholesaleProduct } from "./types";
import { baseSkuOf } from "./variants";

/** One category on the buyer home with its non-empty sub-categories.
 *  Counts are DESIGNS (SKU base = one catalog card), not size/colour rows, so
 *  the number a buyer taps on matches the number of cards they land on. */
export interface CategoryNode {
  name: string;
  count: number;
  subs: { name: string; count: number }[];
}

/**
 * Category / sub-category tree the way the Shopify storefront navigates
 * (Ansh, 26 Sep): "View all designs" first, then each category with its
 * sub-categories underneath, and no sub-category with 0 products. Built from
 * the buyer-visible rows themselves, so an empty branch cannot appear — a
 * category or sub-category only exists here because a published design sits
 * in it. Designs with no category (65 of 141 on go-live day) are reachable
 * only through "View all"; they are counted in totalDesigns and nowhere else.
 */
export function buildCategoryTree(products: WholesaleProduct[]): { totalDesigns: number; categories: CategoryNode[] } {
  const all = new Set<string>();
  const byCat = new Map<string, Set<string>>();
  const bySub = new Map<string, Map<string, Set<string>>>();
  for (const p of products) {
    const base = baseSkuOf(p.sku);
    all.add(base);
    const cat = p.category?.trim();
    if (!cat) continue;
    if (!byCat.has(cat)) byCat.set(cat, new Set());
    byCat.get(cat)!.add(base);
    const sub = p.sub_category?.trim();
    if (!sub) continue;
    if (!bySub.has(cat)) bySub.set(cat, new Map());
    const subs = bySub.get(cat)!;
    if (!subs.has(sub)) subs.set(sub, new Set());
    subs.get(sub)!.add(base);
  }
  const bySize = (a: { name: string; count: number }, b: { name: string; count: number }) => b.count - a.count || a.name.localeCompare(b.name);
  const categories: CategoryNode[] = [...byCat.entries()]
    .map(([name, bases]) => ({
      name,
      count: bases.size,
      subs: [...(bySub.get(name) ?? new Map<string, Set<string>>()).entries()].map(([s, b]) => ({ name: s, count: b.size })).sort(bySize),
    }))
    .sort(bySize);
  return { totalDesigns: all.size, categories };
}

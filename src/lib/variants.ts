import type { WholesaleProduct } from "@/lib/types";

// Drevi SKUs encode variants in the last two segments:
//   DD-SUT-PLZ-008-XL-CRM  →  base DD-SUT-PLZ-008, size XL, color CRM
// The catalog shows one card per base with the size/color combos as chips.
// SKUs that don't match the pattern (fewer than 3 segments) stand alone.

export function baseSkuOf(sku: string): string {
  const parts = sku.split("-");
  return parts.length >= 5 ? parts.slice(0, -2).join("-") : sku;
}

export function variantLabelOf(sku: string): string {
  const parts = sku.split("-");
  return parts.length >= 5 ? `${parts[parts.length - 2]} · ${parts[parts.length - 1]}` : sku;
}

export interface ProductGroup {
  base: string;
  variants: WholesaleProduct[];
}

// Groups preserve the incoming product order (first variant seen leads).
export function groupByBase(products: WholesaleProduct[]): ProductGroup[] {
  const order: string[] = [];
  const map = new Map<string, WholesaleProduct[]>();
  for (const p of products) {
    const base = baseSkuOf(p.sku);
    if (!map.has(base)) {
      map.set(base, []);
      order.push(base);
    }
    map.get(base)!.push(p);
  }
  return order.map((base) => ({ base, variants: map.get(base)! }));
}

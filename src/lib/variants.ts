import type { WholesaleProduct } from "@/lib/types";
// Relative, not "@/lib/sku/vocab": vitest here does not resolve the alias, and
// the dashboard rollup tests load this module.
import { COLOR_GROUPS, SIZES } from "./sku/vocab";

// Drevi SKUs encode variants in the last two segments:
//   DD-SUT-PLZ-008-XL-CRM  →  base DD-SUT-PLZ-008, size XL, color CRM
// The catalog shows one card per base with the size/color combos as chips.
// SKUs that don't match the pattern (fewer than 3 segments) stand alone.

export function baseSkuOf(sku: string): string {
  const parts = sku.split("-");
  return parts.length >= 5 ? parts.slice(0, -2).join("-") : sku;
}

// Raw codes ("XL · CRM"). The staff Dashboard reads these as they are; buyer
// screens use buyerVariantLabel below.
export function variantLabelOf(sku: string): string {
  const parts = sku.split("-");
  return parts.length >= 5 ? `${parts[parts.length - 2]} · ${parts[parts.length - 1]}` : sku;
}

// ── Buyer-facing variants (Oct review) ──────────────────────────────────────
// Catalog chips showed the raw codes in whatever order the query returned.
// Buyers get names from the static vocabulary and the size ladder; a code
// added only in the LoV table has no name here and shows as its code.

function variantParts(sku: string): { size: string; color: string } | null {
  const parts = sku.toUpperCase().split("-");
  return parts.length >= 5 ? { size: parts[parts.length - 2], color: parts[parts.length - 1] } : null;
}

// Object.keys puts the numeric sizes (32…46) ahead of XS…XXXL, then FS, CTM,
// OTH. A design uses one ladder or the other, so within a card this is the
// ladder order.
const SIZE_RANK = new Map<string, number>(Object.keys(SIZES).map((code, i) => [code, i]));
const SIZE_NAME: Record<string, string> = SIZES;
const COLOR_NAME = new Map<string, string>(COLOR_GROUPS.flatMap((g) => g.items.map(([code, name]) => [code, name] as [string, string])));

/** Position on the size ladder; unknown sizes (and SKUs with none) last. */
export function sizeRankOf(sku: string): number {
  const v = variantParts(sku);
  return (v && SIZE_RANK.get(v.size)) ?? SIZE_RANK.size;
}

/** Size ladder first, then colour code, then SKU. Returns a new array. */
export function sortVariantsForBuyer<T extends { sku: string }>(variants: T[]): T[] {
  const colorOf = (sku: string) => variantParts(sku)?.color ?? "";
  return [...variants].sort(
    (a, b) =>
      sizeRankOf(a.sku) - sizeRankOf(b.sku) ||
      colorOf(a.sku).localeCompare(colorOf(b.sku)) ||
      a.sku.localeCompare(b.sku),
  );
}

/**
 * "DD-SUT-PLZ-008-XL-CRM" → "XL · Cream", "…-FS-MRN" → "Free Size · Maroon".
 * Null when the SKU carries no size and colour, so callers do not repeat a
 * bare SKU as if it were a variant.
 */
export function buyerVariantLabel(sku: string): string | null {
  const v = variantParts(sku);
  if (!v) return null;
  return `${SIZE_NAME[v.size] ?? v.size} · ${COLOR_NAME.get(v.color) ?? v.color}`;
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

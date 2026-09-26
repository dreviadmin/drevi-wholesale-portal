import { describeDesignFacts, type VocabLike } from "./facts";

// Category / sub-category NAMES for wholesale_products from the SKU itself.
//
// Ansh, 27 Sep: "62 designs have no category: how's this possible: you can
// always get the category from the SKU." He is right. Every Drevi SKU is
// DD-<CAT>-<SUB>-NNN[-SIZE-COLOR] and the two codes resolve through the same
// vocabulary Studio mints from — yet wholesale_products.category was written
// by ONE writer, the sheet sync, which copied the sheet's Category column
// blank-for-blank. 75 rows on prod (65 of them in the buyer catalog) had a
// blank column and a perfectly decodable SKU; the 240 rows that did carry a
// category agreed with their SKU code 240 times out of 240.
//
// Pure module (no server-only, no supabase) so vitest loads it and the sync,
// the Studio push and the backfill script all share the one rule.

export interface CategoryNames {
  category: string | null;
  subCategory: string | null;
}

const NONE: CategoryNames = { category: null, subCategory: null };

/** The two codes a Drevi SKU carries, or null when the SKU is not Drevi-shaped. */
export function categoryCodesOfSku(sku: string | null | undefined): { cat: string; sub: string } | null {
  const parts = (sku ?? "").trim().toUpperCase().split("-");
  if (parts.length < 4 || parts[0] !== "DD") return null;
  if (!/^[A-Z]{2,4}$/.test(parts[1]) || !/^[A-Z0-9]{2,4}$/.test(parts[2])) return null;
  return { cat: parts[1], sub: parts[2] };
}

/** Names from a pair of CODES. Never echoes a raw code as a name — an unknown
 *  code stays blank rather than putting "LEH" in front of a buyer. A sub only
 *  counts when its parent resolved too (sub codes repeat across categories). */
export function categoryNamesFromCodes(cat: string | null | undefined, sub: string | null | undefined, vocab: VocabLike | null): CategoryNames {
  if (!vocab || !cat?.trim()) return NONE;
  const f = describeDesignFacts({ category: cat, subCategory: sub }, vocab);
  // A LoV row saved without a label makes the vocab carry the code as its
  // name ("KID" → "KID"); that is still a code, not something to show a buyer.
  const isName = (name: string | null, code: string | null) => !!name && !!code && name.trim().toUpperCase() !== code.toUpperCase();
  if (!f.categoryCode || !isName(f.categoryName, f.categoryCode)) return NONE;
  return { category: f.categoryName, subCategory: f.subCategoryCode && isName(f.subCategoryName, f.subCategoryCode) ? f.subCategoryName : null };
}

export function categoryNamesFromSku(sku: string | null | undefined, vocab: VocabLike | null): CategoryNames {
  const codes = categoryCodesOfSku(sku);
  return codes ? categoryNamesFromCodes(codes.cat, codes.sub, vocab) : NONE;
}

/**
 * The sheet-sync rule. The sheet's value wins whenever it typed one — those
 * columns are still sheet-owned — and a blank falls back to the SKU. The
 * sub-category falls back only when the sheet's category (if any) agrees with
 * the SKU's, so a sub is never filed under a foreign parent.
 */
export function catalogCategoryFor(
  sheet: { category: string | null | undefined; subCategory: string | null | undefined },
  sku: string,
  vocab: VocabLike | null,
): CategoryNames {
  const fromSku = categoryNamesFromSku(sku, vocab);
  const sheetCat = sheet.category?.trim() || null;
  const sheetSub = sheet.subCategory?.trim() || null;
  const parentAgrees = !sheetCat || (fromSku.category !== null && sheetCat.toLowerCase() === fromSku.category.toLowerCase());
  return {
    category: sheetCat ?? fromSku.category,
    subCategory: sheetSub ?? (parentAgrees ? fromSku.subCategory : null),
  };
}

/**
 * The Studio-push rule. The design row's own codes come first (they are what
 * the SKU was minted from and what a Specs edit changes); the SKU is the
 * fallback for a design whose codes do not resolve.
 */
export function categoryNamesForDesign(
  design: { category: string | null | undefined; subCategory: string | null | undefined },
  baseSku: string,
  vocab: VocabLike | null,
): CategoryNames {
  const fromDesign = categoryNamesFromCodes(design.category, design.subCategory, vocab);
  return fromDesign.category ? fromDesign : categoryNamesFromSku(baseSku, vocab);
}

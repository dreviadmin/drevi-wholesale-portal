// Copy tags -> Shopify tags. PURE and on its own so it is testable: shopify.ts
// imports server-only, which vitest cannot load (same reason attachment-name.ts
// sits apart from the drive-photo route).

/**
 * The copy's tag object -> the tag list Shopify receives.
 *
 * ONLY `occasion` is split (20 Sep). Shopify already treats a comma inside a
 * tag string as a separator, and 45 of the 180 copy rows on prod write the
 * occasion that way — "Reception, Sangeet, Cocktail" becomes three real tags
 * and the occasion collections pick them up. But 26 rows say "Sangeet and
 * Reception" instead, and that lands as ONE tag which matches no collection
 * rule: the product silently misses Wedding & Sangeet and Cocktail & Reception,
 * and a push would delete the tags someone had added by hand to compensate.
 * The model's choice of "and" over a comma should not decide what a garment is
 * filed under, so both read as list separators here.
 *
 * The other three keys are deliberately NOT split, because their "and" is
 * descriptive rather than a list — silhouette "Bustier and Draped Sharara Set",
 * fabric "Net with Sequin and Cutdana Embroidery". Splitting those would invent
 * tags for garment parts nobody filters on. Their commas still reach Shopify as
 * they always have; changing that is a separate question.
 */
export function shopifyTagsFrom(tagObj: Record<string, string> | null | undefined): string[] {
  if (!tagObj) return [];
  const out: string[] = [];
  for (const [key, raw] of Object.entries(tagObj)) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const parts = key === "occasion" ? raw.split(/\s+and\s+|,/i) : [raw];
    for (const part of parts) {
      const t = part.trim();
      // Case-insensitive de-dupe: Shopify folds tags that differ only by case,
      // and sending both halves of "Reception and reception" is just noise.
      if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    }
  }
  return out;
}

// Copy tags -> Shopify tags and the custom.occasion metafield. PURE and on its
// own so it is testable: shopify.ts imports server-only, which vitest cannot
// load (same reason attachment-name.ts sits apart from the drive-photo route).

/**
 * The words the storefront's occasion collections actually match on, read off
 * the live rule sets (21 Sep):
 *
 *   festive             Festive · Diwali · Navratri · Puja · Party
 *   wedding-sangeet     Wedding · Sangeet · Engagement · Wedding Guest · Bridal · Shaadi
 *   mehendi-haldi       Mehendi · Mehndi · Henna · Haldi
 *   cocktail-reception  Cocktail · Reception
 *
 * Every rule is EQUALS, not CONTAINS. That is the whole reason this file
 * reduces at all: "Wedding Festivities" and "Evening Reception" match NOTHING
 * as written, so a garment the model described perfectly well lands in no
 * collection and under its own one-off value in the storefront filter.
 *
 * Keep this in step with the collection rules in Shopify admin, not with any
 * list in the portal — /admin/lovs holds a different, richer merchandising
 * vocabulary ("Wedding (Bride)", "Karwa Chauth") that the collections do not use.
 */
const COLLECTION_OCCASIONS = new Set([
  "festive", "diwali", "navratri", "puja", "party",
  "wedding", "sangeet", "engagement", "bridal", "shaadi",
  "mehendi", "mehndi", "henna", "haldi",
  "cocktail", "reception",
]);

/**
 * Separators. All three appear in real copy: of the 97 prod rows carrying an
 * occasion, 47 use commas, 34 the word "and", 5 an ampersand.
 *
 * "and" is matched with word boundaries rather than surrounding whitespace so a
 * serial comma still splits: with /\s*,\s*|\s+and\s+/ the comma branch eats the
 * space that " and " needs, and "Sangeet, Mehendi, and Reception" yields the
 * atom "and Reception" — a junk facet value AND a tag that matches no
 * collection. \b keeps "Grand", "Bandhan" and "Anniversary" whole.
 */
const SEPARATOR = /\s*(?:,|&|\band\b)\s*/i;

/** "festive celebrations" -> "Festive Celebrations". The model's capitalisation
 *  is not consistent, and the storefront filter shows "festive" and "Festive"
 *  as two different values. */
function properCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-/])([a-z])/g, (_, lead, c) => lead + c.toUpperCase());
}

/**
 * One occasion string -> the ATOMIC, canonical occasions inside it.
 *
 * Three steps, in order:
 *   1. split on , / & / and
 *   2. Proper Case
 *   3. reduce each to ONE word (Ansh, 21 Sep) — the first word the occasion
 *      collections match on, else the first word. The plain first word is
 *      right 22 times out of the 24 distinct values on prod and wrong exactly
 *      where a qualifier leads: "Evening Reception" -> "Evening" and "Daytime
 *      Reception" -> "Daytime" are not occasions and match no collection,
 *      whereas "Reception" is and does.
 *
 * Step 3 is why this feeds BOTH the tag list and the metafield: a product whose
 * facet says "Reception" but whose tag says "Evening Reception" is in the
 * filter and out of the collection, which is the same bug twice.
 */
export function splitOccasions(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  for (const part of raw.split(SEPARATOR)) {
    const words = properCase(part.trim()).split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const t = words.find((w) => COLLECTION_OCCASIONS.has(w.toLowerCase())) ?? words[0];
    // Case-insensitive de-dupe: Shopify folds tags that differ only by case,
    // and a list metafield showing "Reception" twice is just noise.
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/**
 * The copy's tag object -> the tag list Shopify receives.
 *
 * ONLY `occasion` is split and reduced. The other three keys are deliberately
 * left whole, because their "and" is descriptive rather than a list —
 * silhouette "Bustier and Draped Sharara Set", fabric "Net with Sequin and
 * Cutdana Embroidery". Splitting those would invent tags for garment parts
 * nobody filters on, and reducing them to one word would destroy them.
 */
export function shopifyTagsFrom(tagObj: Record<string, string> | null | undefined): string[] {
  if (!tagObj) return [];
  const out: string[] = [];
  for (const [key, raw] of Object.entries(tagObj)) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    for (const part of key === "occasion" ? splitOccasions(raw) : [raw.trim()]) {
      const t = part.trim();
      if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    }
  }
  return out;
}

import { describe, it, expect } from "vitest";
import { shopifyTagsFrom, splitOccasions } from "./shopify-tags";
import { BUILT_IN_TEMPLATE } from "./studio/copy-prompt";

// The occasion tag decides which collections a product lands in, and the copy
// model writes it two ways. These are real values from the 180 prod copy rows.
describe("shopifyTagsFrom", () => {
  it("splits a comma-written occasion, as Shopify already did", () => {
    expect(
      shopifyTagsFrom({ color: "Black", fabric: "Net", occasion: "Reception, Sangeet, Cocktail", silhouette: "Mermaid" }),
    ).toEqual(["Black", "Net", "Reception", "Sangeet", "Cocktail", "Mermaid"]);
  });

  it("reduces an occasion tag to the word the collections match, so tag and facet agree", () => {
    // "Evening Reception" as a tag matches no collection — every occasion rule
    // in the store is EQUALS. "Reception" joins cocktail-reception.
    expect(shopifyTagsFrom({ occasion: "Evening Reception" })).toEqual(["Reception"]);
    expect(shopifyTagsFrom({ occasion: "Wedding Festivities and Sangeet" })).toEqual(["Wedding", "Sangeet"]);
  });

  it("splits an and-written occasion too — the 26 rows that used to lose their collections", () => {
    expect(shopifyTagsFrom({ color: "Bottle Green", occasion: "Sangeet and Reception" }))
      .toEqual(["Bottle Green", "Sangeet", "Reception"]);
    expect(shopifyTagsFrom({ occasion: "Mehendi and Sangeet" })).toEqual(["Mehendi", "Sangeet"]);
    expect(shopifyTagsFrom({ occasion: "Festive and Daytime Celebrations" }))
      .toEqual(["Festive", "Daytime"]);
  });

  it("never splits silhouette or fabric — their 'and' is descriptive, not a list", () => {
    // Splitting these would invent tags for garment parts nobody filters on.
    expect(shopifyTagsFrom({ silhouette: "Bustier and Draped Sharara Set" }))
      .toEqual(["Bustier and Draped Sharara Set"]);
    expect(shopifyTagsFrom({ fabric: "Net with Sequin and Cutdana Embroidery" }))
      .toEqual(["Net with Sequin and Cutdana Embroidery"]);
    expect(shopifyTagsFrom({ color: "Ivory and Red" })).toEqual(["Ivory and Red"]);
  });

  it("de-dupes case-insensitively and drops blanks", () => {
    expect(shopifyTagsFrom({ occasion: "Sangeet and sangeet, SANGEET" })).toEqual(["Sangeet"]);
    expect(shopifyTagsFrom({ occasion: "  ", color: "Black", fabric: "" })).toEqual(["Black"]);
  });

  it("survives an absent or malformed tag object", () => {
    expect(shopifyTagsFrom(null)).toEqual([]);
    expect(shopifyTagsFrom(undefined)).toEqual([]);
    expect(shopifyTagsFrom({} as Record<string, string>)).toEqual([]);
    expect(shopifyTagsFrom({ occasion: 42 as unknown as string, color: "Black" })).toEqual(["Black"]);
  });
});

// custom.occasion is a LIST metafield built from the same split, so these are
// the exact strings that become its JSON array. Real values from the 97 prod
// copy rows that carry an occasion.
describe("splitOccasions", () => {
  it("splits all three separators the model actually writes", () => {
    expect(splitOccasions("Sangeet, Reception, Festive")).toEqual(["Sangeet", "Reception", "Festive"]);
    expect(splitOccasions("Sangeet and Reception")).toEqual(["Sangeet", "Reception"]);
    // The 5 rows an ampersand used to leave as one unmatchable value.
    expect(splitOccasions("Cocktail & Evening Reception")).toEqual(["Cocktail", "Reception"]);
  });

  // The regression three reviewers caught independently: with /\s*,\s*|\s+and\s+/
  // the comma branch eats the space " and " needs, and the last item keeps the
  // conjunction — a junk facet value and a tag that matches no collection.
  it("splits a serial comma, which an earlier separator regex did not", () => {
    expect(splitOccasions("Sangeet, Mehendi, and Reception")).toEqual(["Sangeet", "Mehendi", "Reception"]);
    expect(splitOccasions("Sangeet, and Reception")).toEqual(["Sangeet", "Reception"]);
    expect(splitOccasions("Sangeet, & Reception")).toEqual(["Sangeet", "Reception"]);
  });

  it("splits a string mixing separators", () => {
    expect(splitOccasions("Sangeet, Mehendi & Cocktail and Reception"))
      .toEqual(["Sangeet", "Mehendi", "Cocktail", "Reception"]);
  });

  it("proper-cases, so the filter shows one value and not three", () => {
    expect(splitOccasions("festive")).toEqual(["Festive"]);
    expect(splitOccasions("wedding functions")).toEqual(["Wedding"]);
    expect(splitOccasions("MEHENDI")).toEqual(["Mehendi"]);
  });

  it("reduces to the first word the occasion collections match on", () => {
    expect(splitOccasions("Wedding Festivities")).toEqual(["Wedding"]);
    expect(splitOccasions("festive celebrations")).toEqual(["Festive"]);
    expect(splitOccasions("Festive Evening")).toEqual(["Festive"]);
    // A LEADING qualifier is what plain first-word gets wrong: "Evening" and
    // "Daytime" are not occasions and match nothing; "Reception" does.
    expect(splitOccasions("Evening Reception")).toEqual(["Reception"]);
    expect(splitOccasions("Daytime Reception")).toEqual(["Reception"]);
  });

  it("falls back to the first word when no word is a known occasion", () => {
    expect(splitOccasions("Daytime Celebrations")).toEqual(["Daytime"]);
    expect(splitOccasions("Garba")).toEqual(["Garba"]);
  });

  it("does not split a word that merely contains 'and'", () => {
    expect(splitOccasions("Grand Reception")).toEqual(["Reception"]);
    expect(splitOccasions("Bandhan")).toEqual(["Bandhan"]);
    expect(splitOccasions("Haldi and Grand Sangeet")).toEqual(["Haldi", "Sangeet"]);
  });

  it("de-dupes after reducing — two wordings of one occasion collapse to one value", () => {
    expect(splitOccasions("Wedding Functions and wedding festivities")).toEqual(["Wedding"]);
    expect(splitOccasions("Sangeet and sangeet, SANGEET")).toEqual(["Sangeet"]);
    expect(splitOccasions("  Mehendi ,, & Sangeet  ")).toEqual(["Mehendi", "Sangeet"]);
  });

  it("returns nothing for an absent or non-string occasion", () => {
    expect(splitOccasions(null)).toEqual([]);
    expect(splitOccasions(undefined)).toEqual([]);
    expect(splitOccasions("")).toEqual([]);
    expect(splitOccasions("   ")).toEqual([]);
    expect(splitOccasions(42 as unknown as string)).toEqual([]);
  });

  // What shopify.ts writes as the list metafield value.
  it("serialises to the JSON array the list metafield takes", () => {
    expect(JSON.stringify(splitOccasions("Sangeet and Mehendi"))).toBe('["Sangeet","Mehendi"]');
  });
});

describe("handwork as the fifth vision tag (25 Sep)", () => {
  it("is asked for in the prompt, so the Shopify draft can stop using the Specs field", () => {
    expect(BUILT_IN_TEMPLATE).toContain('"handwork"');
    // The failure this guards is the reason it was added: a free-text handwork
    // gave 147 distinct values across 155 designs. The prompt must keep
    // pinning it to the technique, not let it drift back to a sentence.
    expect(BUILT_IN_TEMPLATE).toMatch(/handwork[^}]*TECHNIQUES/);
    expect(BUILT_IN_TEMPLATE).toMatch(/handwork[^}]*never a sentence/);
  });

  it("reaches the tag list whole — its 'and' joins techniques, it is not a list", () => {
    expect(shopifyTagsFrom({ handwork: "Zari and Cutdana" })).toEqual(["Zari and Cutdana"]);
    // Reducing it the way occasion is reduced would turn "Mirror Work" into
    // "Mirror", which is a material, not a technique.
    expect(shopifyTagsFrom({ handwork: "Mirror Work" })).toEqual(["Mirror Work"]);
  });

  it("still splits occasion while leaving handwork alone in the same object", () => {
    expect(shopifyTagsFrom({ occasion: "Sangeet and Mehendi", handwork: "Sequin and Bead Work" }))
      .toEqual(["Sangeet", "Mehendi", "Sequin and Bead Work"]);
  });

  it("drops a blank handwork rather than tagging an empty string", () => {
    expect(shopifyTagsFrom({ handwork: "   " })).toEqual([]);
  });
});

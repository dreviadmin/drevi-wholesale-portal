import { describe, it, expect } from "vitest";
import { shopifyTagsFrom } from "./shopify-tags";

// The occasion tag decides which collections a product lands in, and the copy
// model writes it two ways. These are real values from the 180 prod copy rows.
describe("shopifyTagsFrom", () => {
  it("splits a comma-written occasion, as Shopify already did", () => {
    expect(
      shopifyTagsFrom({ color: "Black", fabric: "Net", occasion: "Reception, Sangeet, Cocktail", silhouette: "Mermaid" }),
    ).toEqual(["Black", "Net", "Reception", "Sangeet", "Cocktail", "Mermaid"]);
  });

  it("splits an and-written occasion too — the 26 rows that used to lose their collections", () => {
    expect(shopifyTagsFrom({ color: "Bottle Green", occasion: "Sangeet and Reception" }))
      .toEqual(["Bottle Green", "Sangeet", "Reception"]);
    expect(shopifyTagsFrom({ occasion: "Mehendi and Sangeet" })).toEqual(["Mehendi", "Sangeet"]);
    expect(shopifyTagsFrom({ occasion: "Festive and Daytime Celebrations" }))
      .toEqual(["Festive", "Daytime Celebrations"]);
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

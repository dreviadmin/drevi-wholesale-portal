import { describe, it, expect } from "vitest";
import { missingFields, isMissingKey, MISSING_KEYS, type MissingInput } from "./missing";
import type { VocabLike } from "./facts";

const VOCAB: VocabLike = {
  categories: { LEH: { name: "Lehenga", subs: { MRM: "Mermaid" } } },
  colorGroups: [{ name: "Metallics", items: [["GLD", "Gold"], ["SLV", "Silver"]] }],
};

const FULL: MissingInput = {
  origin: "curated", fabric: "Net", handwork: "Sequin",
  color: "GLD", colorName: "Gold", category: "LEH", subCategory: "MRM",
  mrpOverride: null, autoMrp: 17499, wholesalePriceSet: true,
};

describe("missingFields", () => {
  it("finds nothing on a complete design", () => {
    expect(missingFields(FULL, VOCAB)).toEqual([]);
  });

  it("reports origin — the gap that put 21 products on Shopify in one size", () => {
    expect(missingFields({ ...FULL, origin: null }, VOCAB)).toEqual(["origin"]);
    expect(missingFields({ ...FULL, origin: "   " }, VOCAB)).toEqual(["origin"]);
  });

  it("treats a resolvable colour code as a colour, and an unknown one as missing", () => {
    // Both live Shopify products carry color_name null; SLV resolves to Silver,
    // so flagging them would be noise.
    expect(missingFields({ ...FULL, colorName: null }, VOCAB)).toEqual([]);
    expect(missingFields({ ...FULL, colorName: null, color: "ZZZ" }, VOCAB)).toEqual(["colour"]);
    // No vocabulary at all: the stored name is the only evidence left.
    expect(missingFields({ ...FULL, colorName: null }, null)).toEqual(["colour"]);
    expect(missingFields({ ...FULL, colorName: "Gold" }, null)).toEqual([]);
  });

  it("reports a retail price of zero, null or absent — nothing gates on it", () => {
    expect(missingFields({ ...FULL, autoMrp: null }, VOCAB)).toEqual(["retail_price"]);
    expect(missingFields({ ...FULL, autoMrp: 0 }, VOCAB)).toEqual(["retail_price"]);
    // An override wins over the auto price, in both directions.
    expect(missingFields({ ...FULL, mrpOverride: 13595, autoMrp: null }, VOCAB)).toEqual([]);
    expect(missingFields({ ...FULL, mrpOverride: 0, autoMrp: 17499 }, VOCAB)).toEqual(["retail_price"]);
  });

  it("reports the wholesale price from the group, not the design row", () => {
    expect(missingFields({ ...FULL, wholesalePriceSet: false }, VOCAB)).toEqual(["wholesale_price"]);
  });

  it("reports every descriptive gap, in chip order", () => {
    const bare: MissingInput = {
      origin: null, fabric: null, handwork: null, color: null, colorName: null,
      category: null, subCategory: null, mrpOverride: null, autoMrp: null, wholesalePriceSet: false,
    };
    expect(missingFields(bare, VOCAB)).toEqual(MISSING_KEYS);
  });

  it("guards the keys that arrive from the URL", () => {
    expect(isMissingKey("origin")).toBe(true);
    expect(isMissingKey("ORIGIN")).toBe(false);
    expect(isMissingKey("nonsense")).toBe(false);
    expect(isMissingKey(7)).toBe(false);
  });
});

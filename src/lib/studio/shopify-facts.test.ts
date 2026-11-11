import { describe, it, expect } from "vitest";
import { shopifyFactsChanged, shopifyRetail } from "./shopify-facts";

const specs = { fabric: "Silk", handwork: "Zardosi", origin: "curated", color_name: "Champagne Gold" };
const prices = { auto_mrp: 4999, mrp_override: null, compare_at_price: null };

describe("shopifyRetail", () => {
  it("is the override when there is one, else the auto MRP", () => {
    expect(shopifyRetail({ auto_mrp: 4999, mrp_override: 5499 })).toBe(5499);
    expect(shopifyRetail({ auto_mrp: 4999, mrp_override: null })).toBe(4999);
  });

  it("reads 0, blank and junk as not priced", () => {
    expect(shopifyRetail({ auto_mrp: 0, mrp_override: 0 })).toBeNull();
    expect(shopifyRetail({ auto_mrp: null, mrp_override: undefined })).toBeNull();
    expect(shopifyRetail({ auto_mrp: "abc" })).toBeNull();
    expect(shopifyRetail({ auto_mrp: "4999.00" })).toBe(4999);
  });
});

describe("shopifyFactsChanged — the specs half", () => {
  it("is false when the save writes the same facts", () => {
    expect(shopifyFactsChanged(specs, { ...specs })).toBe(false);
  });

  it("is true when any one fact moves", () => {
    expect(shopifyFactsChanged(specs, { ...specs, fabric: "Georgette" })).toBe(true);
    expect(shopifyFactsChanged(specs, { ...specs, handwork: null })).toBe(true);
    expect(shopifyFactsChanged(specs, { ...specs, origin: "drevi_original" })).toBe(true);
    expect(shopifyFactsChanged(specs, { ...specs, color_name: "Rose Gold" })).toBe(true);
  });

  it("treats blank, null and stray spaces as the same value", () => {
    expect(shopifyFactsChanged({ ...specs, handwork: null }, { ...specs, handwork: "" })).toBe(false);
    expect(shopifyFactsChanged({ ...specs, handwork: "" }, { ...specs, handwork: "   " })).toBe(false);
    expect(shopifyFactsChanged(specs, { ...specs, fabric: " Silk " })).toBe(false);
  });

  it("ignores fields the push does not read (style, supply, the verified tick)", () => {
    const saved = { ...specs, style: "traditional", supply_note: "2 weeks", specs_verified: true };
    expect(shopifyFactsChanged(specs, saved)).toBe(false);
  });

  it("ignores a key the save does not write", () => {
    expect(shopifyFactsChanged(specs, { fabric: "Silk" })).toBe(false);
    expect(shopifyFactsChanged(specs, { fabric: undefined, handwork: "Zardosi" })).toBe(false);
  });
});

describe("shopifyFactsChanged — the price half", () => {
  it("is true when the selling price moves, by cost, multiplier or override", () => {
    expect(shopifyFactsChanged(prices, { auto_mrp: 5299, mrp_override: null })).toBe(true);
    expect(shopifyFactsChanged(prices, { auto_mrp: 4999, mrp_override: 5999 })).toBe(true);
    expect(shopifyFactsChanged({ auto_mrp: 4999, mrp_override: 5999 }, { auto_mrp: 4999, mrp_override: null })).toBe(true);
  });

  it("is false when only the auto MRP moves under an override", () => {
    expect(shopifyFactsChanged({ auto_mrp: 4999, mrp_override: 5999 }, { auto_mrp: 5299, mrp_override: 5999 })).toBe(false);
  });

  it("is false when the price is unchanged, including number vs numeric string", () => {
    expect(shopifyFactsChanged(prices, { auto_mrp: 4999, mrp_override: null })).toBe(false);
    expect(shopifyFactsChanged({ auto_mrp: "4999.00", mrp_override: null }, { auto_mrp: 4999, mrp_override: null })).toBe(false);
  });

  it("compares the compare-at only when the save writes it", () => {
    expect(shopifyFactsChanged(prices, { auto_mrp: 4999, mrp_override: null, compare_at_price: 6999 })).toBe(true);
    expect(shopifyFactsChanged({ ...prices, compare_at_price: 6999 }, { auto_mrp: 4999, mrp_override: null, compare_at_price: null })).toBe(true);
    expect(shopifyFactsChanged({ ...prices, compare_at_price: 6999 }, { auto_mrp: 4999, mrp_override: null })).toBe(false);
    expect(shopifyFactsChanged({ ...prices, compare_at_price: 6999 }, { auto_mrp: 4999, mrp_override: null, compare_at_price: 6999 })).toBe(false);
  });
});

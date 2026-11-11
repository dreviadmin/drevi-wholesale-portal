import { describe, expect, it } from "vitest";
import { buyerVariantLabel, sizeRankOf, sortVariantsForBuyer, variantLabelOf } from "./variants";

const base = "DD-SUT-PLZ-008";
const v = (size: string, color = "CRM") => ({ sku: `${base}-${size}-${color}` });

describe("buyerVariantLabel", () => {
  it("names the size and colour", () => {
    expect(buyerVariantLabel("DD-SUT-PLZ-008-XL-CRM")).toBe("XL · Cream");
    expect(buyerVariantLabel("DD-LEH-FLR-001-FS-MRN")).toBe("Free Size · Maroon");
    expect(buyerVariantLabel("DD-GWN-FLR-010-36-RBL")).toBe("36 · Royal Blue");
  });
  it("passes a code with no name through (added only in the LoV table)", () => {
    expect(buyerVariantLabel("DD-SUT-PLZ-008-M-ZZQ")).toBe("M · ZZQ");
    expect(buyerVariantLabel("DD-SUT-PLZ-008-Q9-CRM")).toBe("Q9 · Cream");
  });
  it("is null for a SKU with no size and colour", () => {
    expect(buyerVariantLabel("CUSTOM-1")).toBeNull();
    expect(buyerVariantLabel("DD-SUT-PLZ-008")).toBeNull();
  });
  it("leaves the staff label alone", () => {
    expect(variantLabelOf("DD-SUT-PLZ-008-XL-CRM")).toBe("XL · CRM");
  });
});

describe("sortVariantsForBuyer", () => {
  it("puts sizes on the ladder whatever order the query returned", () => {
    const shuffled = [v("XL"), v("FS"), v("S"), v("XXL"), v("M"), v("L")];
    expect(sortVariantsForBuyer(shuffled).map((x) => x.sku.split("-")[4])).toEqual(["S", "M", "L", "XL", "XXL", "FS"]);
  });
  it("orders numeric sizes upwards", () => {
    expect(sortVariantsForBuyer([v("40"), v("34"), v("38")]).map((x) => x.sku.split("-")[4])).toEqual(["34", "38", "40"]);
  });
  it("puts unknown sizes last, then colour, then SKU", () => {
    const out = sortVariantsForBuyer([v("Q9"), v("M", "RED"), v("M", "BLK")]);
    expect(out.map((x) => x.sku)).toEqual([`${base}-M-BLK`, `${base}-M-RED`, `${base}-Q9-CRM`]);
  });
  it("does not reorder the caller's array", () => {
    const input = [v("L"), v("S")];
    sortVariantsForBuyer(input);
    expect(input.map((x) => x.sku)).toEqual([`${base}-L-CRM`, `${base}-S-CRM`]);
  });
});

describe("sizeRankOf", () => {
  it("ranks S before M before L, unknown last", () => {
    expect(sizeRankOf(v("S").sku)).toBeLessThan(sizeRankOf(v("M").sku));
    expect(sizeRankOf(v("M").sku)).toBeLessThan(sizeRankOf(v("L").sku));
    expect(sizeRankOf(v("Q9").sku)).toBeGreaterThan(sizeRankOf(v("OTH").sku));
    expect(sizeRankOf("CUSTOM-1")).toBe(sizeRankOf(v("Q9").sku));
  });
});

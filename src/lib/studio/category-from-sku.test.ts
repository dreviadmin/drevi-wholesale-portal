import { describe, it, expect } from "vitest";
import { CATEGORIES, COLOR_GROUPS } from "../sku/vocab";
import type { VocabLike } from "./facts";
import { catalogCategoryFor, categoryCodesOfSku, categoryNamesForDesign, categoryNamesFromSku } from "./category-from-sku";

function staticVocab(): VocabLike {
  return {
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([code, c]) => [code, { name: c.name, subs: { ...c.subs } }])),
    colorGroups: COLOR_GROUPS.map((g) => ({ name: g.name, items: g.items.map(([c, n]) => [c, n] as [string, string]) })),
  };
}
const vocab = staticVocab();

describe("categoryCodesOfSku", () => {
  it("reads the two codes off base and full SKUs, case-insensitively", () => {
    expect(categoryCodesOfSku("DD-LEH-FLR-144")).toEqual({ cat: "LEH", sub: "FLR" });
    expect(categoryCodesOfSku("dd-sar-prd-091-fs-gld")).toEqual({ cat: "SAR", sub: "PRD" });
  });
  it("refuses anything that is not Drevi-shaped", () => {
    expect(categoryCodesOfSku("SKU123")).toBeNull();
    expect(categoryCodesOfSku("DD-LEH")).toBeNull();
    expect(categoryCodesOfSku("XX-LEH-FLR-001")).toBeNull();
    expect(categoryCodesOfSku(null)).toBeNull();
  });
});

describe("categoryNamesFromSku — the rule behind 'you can always get the category from the SKU'", () => {
  it("resolves the prod shapes that were sitting blank", () => {
    expect(categoryNamesFromSku("DD-LEH-FLR-144-M-RED", vocab)).toEqual({ category: "Lehenga", subCategory: "Flared / Kali" });
    expect(categoryNamesFromSku("DD-SAR-PRD-091", vocab)).toEqual({ category: "Saree", subCategory: "Pre-Draped" });
    expect(categoryNamesFromSku("DD-SEP-SKT-008", vocab)).toEqual({ category: "Separates", subCategory: "Skirt" });
    expect(categoryNamesFromSku("DD-SUT-PLZ-050", vocab)).toEqual({ category: "Suit Set", subCategory: "Palazzo Suit" });
    expect(categoryNamesFromSku("DD-IWS-DHT-003", vocab)).toEqual({ category: "Indo-Western Set", subCategory: "Dhoti Set" });
  });
  it("resolves the sub through its own parent — FLR is Flared/Kali under LEH but Floor-Length under GWN", () => {
    expect(categoryNamesFromSku("DD-GWN-FLR-001", vocab).subCategory).toBe("Floor-Length");
    expect(categoryNamesFromSku("DD-SUT-FLR-001", vocab).subCategory).toBe("Floor-Length Suit");
  });
  it("a LoV entry saved without a label (name === code) counts as unresolved", () => {
    const v: VocabLike = { categories: { ...vocab.categories, KID: { name: "KID", subs: { BOY: "BOY", GRL: "Girl" } } }, colorGroups: [] };
    expect(categoryNamesFromSku("DD-KID-BOY-001", v)).toEqual({ category: null, subCategory: null });
    const v2: VocabLike = { categories: { ...vocab.categories, KID: { name: "Kids", subs: { BOY: "BOY", GRL: "Girl" } } }, colorGroups: [] };
    expect(categoryNamesFromSku("DD-KID-BOY-001", v2)).toEqual({ category: "Kids", subCategory: null });
    expect(categoryNamesFromSku("DD-KID-GRL-001", v2)).toEqual({ category: "Kids", subCategory: "Girl" });
  });

  it("never writes a raw code as a name", () => {
    expect(categoryNamesFromSku("DD-ZZZ-FLR-001", vocab)).toEqual({ category: null, subCategory: null });
    expect(categoryNamesFromSku("DD-LEH-ZZZ-001", vocab)).toEqual({ category: "Lehenga", subCategory: null });
    expect(categoryNamesFromSku("DD-LEH-FLR-001", null)).toEqual({ category: null, subCategory: null });
  });
});

describe("catalogCategoryFor — the sheet keeps ownership, the SKU fills the blanks", () => {
  const sku = "DD-LEH-FLR-144-M-RED";
  it("blank sheet → both from the SKU", () => {
    expect(catalogCategoryFor({ category: "", subCategory: null }, sku, vocab)).toEqual({ category: "Lehenga", subCategory: "Flared / Kali" });
  });
  it("typed sheet values win verbatim, even a legacy plural", () => {
    expect(catalogCategoryFor({ category: "Lehengas", subCategory: "Bridal" }, sku, vocab)).toEqual({ category: "Lehengas", subCategory: "Bridal" });
  });
  it("sheet category only: the sub comes from the SKU when the parent agrees…", () => {
    expect(catalogCategoryFor({ category: "lehenga", subCategory: " " }, sku, vocab)).toEqual({ category: "lehenga", subCategory: "Flared / Kali" });
  });
  it("…and stays blank when the sheet filed it under a different parent", () => {
    expect(catalogCategoryFor({ category: "Gown", subCategory: null }, sku, vocab)).toEqual({ category: "Gown", subCategory: null });
  });
  it("an undecodable SKU with a blank sheet stays blank (no invented names)", () => {
    expect(catalogCategoryFor({ category: null, subCategory: null }, "LEGACY-1", vocab)).toEqual({ category: null, subCategory: null });
  });
});

describe("categoryNamesForDesign — the Studio push", () => {
  it("prefers the design's own codes", () => {
    expect(categoryNamesForDesign({ category: "GWN", subCategory: "BLL" }, "DD-LEH-FLR-001", vocab)).toEqual({ category: "Gown", subCategory: "Ball Gown" });
  });
  it("falls back to the SKU when the design codes do not resolve", () => {
    expect(categoryNamesForDesign({ category: null, subCategory: null }, "DD-LEH-FLR-001", vocab)).toEqual({ category: "Lehenga", subCategory: "Flared / Kali" });
    expect(categoryNamesForDesign({ category: "Sarees", subCategory: null }, "DD-SAR-PRD-001", vocab)).toEqual({ category: "Saree", subCategory: "Pre-Draped" });
  });
});

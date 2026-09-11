import { describe, it, expect } from "vitest";
import { CATEGORIES, COLOR_GROUPS } from "../sku/vocab";
import { colorNameFor, describeDesignFacts, promptDesignFrom, type VocabLike } from "./facts";
import { defaultAnglePrompt } from "./prompts";

// Mirrors the shape loadVocab() builds from the static seed (a mutable copy,
// so a test can extend it the way a LoV row would).
function staticVocab(): VocabLike {
  return {
    categories: Object.fromEntries(
      Object.entries(CATEGORIES).map(([code, c]) => [code, { name: c.name, subs: { ...c.subs } }]),
    ),
    colorGroups: COLOR_GROUPS.map((g) => ({ name: g.name, items: g.items.map(([c, n]) => [c, n] as [string, string]) })),
  };
}
const vocab = staticVocab();

describe("describeDesignFacts — codes become names for prose", () => {
  it("resolves app-minted codes to the vocab names and echoes the codes", () => {
    expect(describeDesignFacts({ category: "SAR", subCategory: "PRD", color: "GLD" }, vocab)).toEqual({
      categoryCode: "SAR", categoryName: "Saree",
      subCategoryCode: "PRD", subCategoryName: "Pre-Draped",
      colorCode: "GLD", colorName: "Gold",
    });
  });

  it("keys lookups on the uppercased value", () => {
    const f = describeDesignFacts({ category: "sar", subCategory: " prd ", color: "gld" }, vocab);
    expect(f.categoryName).toBe("Saree");
    expect(f.subCategoryName).toBe("Pre-Draped");
    expect(f.colorName).toBe("Gold");
    expect([f.categoryCode, f.subCategoryCode, f.colorCode]).toEqual(["SAR", "PRD", "GLD"]);
  });

  it("lets staff free-text colour_name beat the vocab name, keeping the code", () => {
    const f = describeDesignFacts({ category: "SAR", subCategory: "PRD", color: "GLD", colorName: "Champagne Gold" }, vocab);
    expect(f.colorName).toBe("Champagne Gold");
    expect(f.colorCode).toBe("GLD");
    // Blank free text does not shadow the vocab.
    expect(describeDesignFacts({ color: "GLD", colorName: "   " }, vocab).colorName).toBe("Gold");
  });

  it("passes unknown codes through verbatim with null codes and no colour name", () => {
    expect(describeDesignFacts({ category: "ZZZ", subCategory: "QQQ", color: "XXX" }, vocab)).toEqual({
      categoryCode: null, categoryName: "ZZZ",
      subCategoryCode: null, subCategoryName: "QQQ",
      colorCode: "XXX", colorName: null,
    });
  });

  it("leaves sheet-born names untouched — never uppercased or canonicalised", () => {
    const f = describeDesignFacts({ category: "Sarees", subCategory: "Pre-Draped" }, vocab);
    expect(f.categoryName).toBe("Sarees");
    expect(f.subCategoryName).toBe("Pre-Draped");
    expect(f.categoryCode).toBeNull();
    expect(f.subCategoryCode).toBeNull();
  });

  it("degrades to today's behaviour when the vocab is null", () => {
    expect(describeDesignFacts({ category: "SAR", subCategory: "PRD", color: "GLD" }, null)).toEqual({
      categoryCode: null, categoryName: "SAR",
      subCategoryCode: null, subCategoryName: "PRD",
      colorCode: "GLD", colorName: null,
    });
    expect(colorNameFor("GLD", null)).toBeNull();
  });

  it("resolves sub-categories only through the parent category (codes repeat across categories)", () => {
    expect(describeDesignFacts({ category: "GWN", subCategory: "FLR" }, vocab).subCategoryName).toBe("Floor-Length");
    expect(describeDesignFacts({ category: "LEH", subCategory: "FLR" }, vocab).subCategoryName).toBe("Flared / Kali");
    expect(describeDesignFacts({ category: "SUT", subCategory: "FLR" }, vocab).subCategoryName).toBe("Floor-Length Suit");
    // A known sub code under an unresolvable category is NOT looked up flat.
    const orphan = describeDesignFacts({ category: "Sarees", subCategory: "PRD" }, vocab);
    expect(orphan.subCategoryName).toBe("PRD");
    expect(orphan.subCategoryCode).toBeNull();
  });

  it("sees colours added through the LoV table", () => {
    const live = staticVocab();
    live.colorGroups.push({ name: "Added in portal", items: [["RNI", "Rani Pink"]] });
    expect(colorNameFor("RNI", live)).toBe("Rani Pink");
    expect(colorNameFor("rni", live)).toBe("Rani Pink");
    expect(colorNameFor("RNI", vocab)).toBeNull();
    expect(colorNameFor(null, live)).toBeNull();
    expect(colorNameFor("", live)).toBeNull();
  });
});

describe("promptDesignFrom — one object for both the angle and copy builders", () => {
  const row = { title: "Test", category: "SAR", sub_category: "PRD", color: "GLD", fabric: "georgette", tier: "hero", bg_style: "auto", base_sku: "DD-SAR-PRD-001" };

  it("feeds names, not codes, into the angle prompt", () => {
    const p = defaultAnglePrompt("front", "fashn", promptDesignFrom(row, vocab));
    expect(p).toContain("Gold georgette Pre-Draped");
    expect(p).not.toContain("GLD");
    expect(p).not.toContain("PRD");
  });

  it("carries the codes, the bg seed and the raw spec fields", () => {
    const d = promptDesignFrom(row, vocab);
    expect(d).toMatchObject({
      title: "Test", category: "Saree", subCategory: "Pre-Draped", categoryCode: "SAR", subCategoryCode: "PRD",
      color: "GLD", colorName: "Gold", fabric: "georgette", tier: "hero", bgStyle: "auto", bgSeed: "DD-SAR-PRD-001|GLD",
    });
  });

  it("tolerates a missing row", () => {
    const d = promptDesignFrom(null, vocab);
    expect(d.category).toBeNull();
    expect(d.colorName).toBeNull();
    expect(d.bgSeed).toBe("|");
    expect(defaultAnglePrompt("front", "fashn", d)).toContain("the garment in the source photo");
  });
});

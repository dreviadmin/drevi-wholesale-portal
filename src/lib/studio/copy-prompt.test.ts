import { describe, it, expect } from "vitest";
import { CATEGORIES, COLOR_GROUPS } from "../sku/vocab";
import { BUILT_IN_TEMPLATE, defaultCopyPrompt } from "./copy-prompt";
import { promptDesignFrom, type VocabLike } from "./facts";

const vocab: VocabLike = {
  categories: Object.fromEntries(
    Object.entries(CATEGORIES).map(([code, c]) => [code, { name: c.name, subs: { ...c.subs } }]),
  ),
  colorGroups: COLOR_GROUPS.map((g) => ({ name: g.name, items: g.items.map(([c, n]) => [c, n] as [string, string]) })),
};
const lines = (prompt: string) => prompt.split("\n");
const row = { title: "Test", category: "SAR", sub_category: "PRD", color: "GLD", tier: "hero" };

describe("defaultCopyPrompt — FACTS name the garment, codes in brackets", () => {
  it("keeps the template verbatim and appends a FACTS block", () => {
    const p = defaultCopyPrompt(promptDesignFrom(row, vocab));
    expect(p.startsWith(BUILT_IN_TEMPLATE)).toBe(true);
    expect(p).toContain("\n\nFACTS:\n");
    expect(lines(p)).toEqual(expect.arrayContaining(["Working name: Test", "Tier: hero"]));
  });

  it("writes 'Category: Saree / Pre-Draped (code SAR-PRD)' and 'Colour: Gold (code GLD)'", () => {
    const p = defaultCopyPrompt(promptDesignFrom(row, vocab));
    expect(lines(p)).toContain("Category: Saree / Pre-Draped (code SAR-PRD)");
    expect(lines(p)).toContain("Colour: Gold (code GLD)");
    expect(p).not.toContain("SAR / PRD");
  });

  it("lets a free-text colour name override the vocab name", () => {
    const p = defaultCopyPrompt(promptDesignFrom({ ...row, color_name: "Champagne Gold" }, vocab));
    expect(lines(p)).toContain("Colour: Champagne Gold (code GLD)");
    expect(p).not.toContain("Colour: Gold");
  });

  it("passes unknown codes through with no code tag", () => {
    const p = defaultCopyPrompt(promptDesignFrom({ category: "ZZZ", sub_category: "QQQ", color: "XXX" }, vocab));
    expect(lines(p)).toContain("Category: ZZZ / QQQ");
    expect(lines(p)).toContain("Colour code: XXX");
    expect(p).not.toContain("(code");
  });

  it("passes sheet-born names through with no code tag", () => {
    const p = defaultCopyPrompt(promptDesignFrom({ category: "Sarees", sub_category: "Pre-Draped" }, vocab));
    expect(lines(p)).toContain("Category: Sarees / Pre-Draped");
    expect(p).not.toContain("(code");
  });

  it("drops the dangling slash when there is no sub-category", () => {
    const p = defaultCopyPrompt(promptDesignFrom({ category: "SAR", color: "GLD" }, vocab));
    expect(lines(p)).toContain("Category: Saree (code SAR)");
    expect(p).not.toMatch(/Category: .*\/\s*(\(|$)/m);
  });

  it("omits the code tag when the label already IS the code", () => {
    const live: VocabLike = { ...vocab, categories: { ...vocab.categories, NEW: { name: "NEW", subs: {} } } };
    const p = defaultCopyPrompt(promptDesignFrom({ category: "NEW" }, live));
    expect(lines(p)).toContain("Category: NEW");
    expect(p).not.toContain("(code");
  });

  it("degrades to codes-as-text when no vocab is available", () => {
    const p = defaultCopyPrompt(promptDesignFrom(row, null));
    expect(lines(p)).toContain("Category: SAR / PRD");
    expect(lines(p)).toContain("Colour code: GLD");
    expect(p).not.toContain("(code");
  });

  it("omits Category and Colour lines entirely when the design has neither", () => {
    const p = defaultCopyPrompt({ title: "Bare" });
    expect(p).not.toContain("Category:");
    expect(p).not.toContain("Colour");
    expect(lines(p)).toContain("Working name: Bare");
  });
});

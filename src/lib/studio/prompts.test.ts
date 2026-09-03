import { describe, it, expect } from "vitest";
import { defaultAnglePrompt, garmentPhrase } from "./prompts";
import { resolveBgPreset, BG_PRESETS } from "./backgrounds";

const design = { category: "Kurta Set", subCategory: "Anarkali", color: "BGE", fabric: "chanderi", handwork: "gota patti", bgSeed: "DD-KUR-ANA-001|BGE" };

describe("per-design studio backgrounds (3 Sep)", () => {
  it("every model angle of one design shares ONE background clause", () => {
    const bg = resolveBgPreset(null, design.bgSeed).prompt.slice(0, 30);
    for (const angle of ["front", "back", "side", "lifestyle"]) {
      const p = defaultAnglePrompt(angle, "fashn", design);
      expect(p.toLowerCase()).toContain(bg.toLowerCase());
      expect(p).toContain("chanderi");
      expect(p.toLowerCase()).toContain("contact shadow");
    }
  });

  it("'auto' is deterministic per seed and varies across designs", () => {
    const a1 = resolveBgPreset("auto", "DD-A|RED");
    const a2 = resolveBgPreset("auto", "DD-A|RED");
    expect(a1.key).toBe(a2.key); // same design → same pick, always
    const keys = new Set(["DD-A|RED", "DD-B|BLU", "DD-C|GRN", "DD-D|PNK", "DD-E|IVR", "DD-F|GLD"].map((s) => resolveBgPreset("auto", s).key));
    expect(keys.size).toBeGreaterThan(1); // different designs actually vary
  });

  it("an explicit preset always wins over auto; unknown falls back to auto", () => {
    expect(resolveBgPreset("charcoal", "whatever").key).toBe("charcoal");
    expect(BG_PRESETS.some((p) => p.key === resolveBgPreset("no-such", "seed").key)).toBe(true);
  });

  it("treats lifestyle as a slot, not a scene — it differs only in framing", () => {
    const front = defaultAnglePrompt("front", "fashn", design);
    const lifestyle = defaultAnglePrompt("lifestyle", "fashn", design);
    expect(lifestyle).not.toEqual(front);
    expect(lifestyle.toLowerCase()).not.toMatch(/street|garden|cafe|outdoor|location scene/);
  });

  it("makes openai_bg a background normalisation, never a restyle", () => {
    const p = defaultAnglePrompt("front", "openai_bg", design);
    expect(p.toLowerCase()).toContain("replace the background");
    expect(p.toLowerCase()).toContain("do not restyle");
  });

  it("detail angles get a macro-safe background prompt for EDIT engines only", () => {
    const p = defaultAnglePrompt("detail_1", "seedream", design);
    expect(p.toLowerCase()).toContain("pixel-exact");
    expect(p.toLowerCase()).toContain("background only");
    expect(defaultAnglePrompt("detail_1", "fashn", design)).toBe("");
    expect(defaultAnglePrompt("detail_2", "raw", design)).toBe("");
  });

  it("prefers the human colour name over the SKU code", () => {
    expect(garmentPhrase({ ...design, colorName: "Champagne Gold" })).toBe("Champagne Gold chanderi Anarkali with gota patti");
    expect(garmentPhrase(design)).toBe("BGE chanderi Anarkali with gota patti");
    expect(garmentPhrase({})).toBe("the garment in the source photo");
  });
});

import { describe, it, expect } from "vitest";
import { defaultAnglePrompt, garmentPhrase, STUDIO_BACKGROUND } from "./prompts";

const design = { category: "Kurta Set", subCategory: "Anarkali", color: "BGE", fabric: "chanderi", handwork: "gota patti" };

describe("uniform grey studio prompts (§7.1)", () => {
  it("puts every model angle on the same grey background — no tier, no scene", () => {
    for (const angle of ["front", "back", "side", "lifestyle"]) {
      const p = defaultAnglePrompt(angle, "fashn", design);
      expect(p.toLowerCase()).toContain("neutral grey studio background");
      expect(p).toContain("chanderi");
    }
  });

  it("treats lifestyle as a slot, not a scene — it differs only in framing", () => {
    const front = defaultAnglePrompt("front", "fashn", design);
    const lifestyle = defaultAnglePrompt("lifestyle", "fashn", design);
    expect(lifestyle).not.toEqual(front);
    expect(lifestyle.toLowerCase()).toContain(STUDIO_BACKGROUND.slice(0, 20).toLowerCase());
    // No outdoor/scene words leak in.
    expect(lifestyle.toLowerCase()).not.toMatch(/street|garden|cafe|outdoor|location|backdrop scene/);
  });

  it("makes openai_bg a background normalisation, never a restyle", () => {
    const p = defaultAnglePrompt("front", "openai_bg", design);
    expect(p.toLowerCase()).toContain("replace the background");
    expect(p.toLowerCase()).toContain("do not restyle");
  });

  it("never builds a prompt for detail angles — they are never processed", () => {
    expect(defaultAnglePrompt("detail_1", "fashn", design)).toBe("");
    expect(defaultAnglePrompt("detail_2", "raw", design)).toBe("");
  });

  it("describes the garment only from its own specs", () => {
    expect(garmentPhrase(design)).toBe("BGE chanderi Anarkali with gota patti");
    expect(garmentPhrase({})).toBe("the garment in the source photo");
  });
});

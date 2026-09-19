import { describe, it, expect } from "vitest";
import { defaultAnglePrompt, garmentPhrase } from "./prompts";
import { resolveBackground, BG_COLOURS, BG_STYLES, isBgStyle, platePathFor } from "./backgrounds";

const design = {
  category: "Kurta Set",
  subCategory: "Anarkali",
  color: "BGE",
  fabric: "chanderi",
  handwork: "gota patti",
  bgSeed: "DD-KUR-ANA-001|BGE",
};

const MINIMAL = "make this retail website ready: color correction and background change";
const COLOURED = `${MINIMAL}. Use the attached background.`;

const EDIT_ENGINES = ["openai_bg", "seedream"] as const;
const MODEL_ANGLES = ["front", "back", "side", "lifestyle"] as const;
const DETAILS = ["detail_1", "detail_2"] as const;

describe("three background modes (19 Sep)", () => {
  it("stores exactly the eight legal values", () => {
    expect([...BG_STYLES]).toEqual(["minimal", "grey", "auto", "ivory", "sand", "stone", "blush", "midnight"]);
    expect(isBgStyle("minimal")).toBe(true);
    expect(isBgStyle("champagne")).toBe(false); // retired by 0053
  });

  it("minimal is the default — unset, empty and unknown all land there", () => {
    for (const v of [null, undefined, "", "   ", "champagne", "taupe", "charcoal"]) {
      const bg = resolveBackground(v, "DD-A|RED");
      expect(bg.mode).toBe("minimal");
      expect(bg.stored).toBe("minimal");
      expect(bg.platePath).toBeNull();
    }
  });

  it("minimal and grey are prompt-only — no plate is ever attached", () => {
    expect(resolveBackground("minimal", "s").platePath).toBeNull();
    expect(resolveBackground("grey", "s").platePath).toBeNull();
    expect(resolveBackground("grey", "s").mode).toBe("grey");
  });

  it("every colour key is coloured mode and carries its plate path", () => {
    for (const c of BG_COLOURS) {
      const bg = resolveBackground(c.key, "s");
      expect(bg.mode).toBe("coloured");
      expect(bg.colourKey).toBe(c.key);
      expect(bg.platePath).toBe(`_backgrounds/${c.key}.jpg`);
      expect(bg.label).toBe(c.label);
    }
    expect(platePathFor("sand")).toBe("_backgrounds/sand.jpg");
  });

  it("'auto' is deterministic per seed, coloured, and varies across designs", () => {
    const a1 = resolveBackground("auto", "DD-A|RED");
    const a2 = resolveBackground("auto", "DD-A|RED");
    expect(a1.colourKey).toBe(a2.colourKey); // same design → same pick, always
    expect(a1.mode).toBe("coloured");
    expect(a1.stored).toBe("auto"); // the stored value stays 'auto'
    expect(a1.platePath).not.toBeNull();
    const keys = new Set(
      ["DD-A|RED", "DD-B|BLU", "DD-C|GRN", "DD-D|PNK", "DD-E|IVR", "DD-F|GLD", "DD-G|BLK", "DD-H|WHT"].map(
        (s) => resolveBackground("auto", s).colourKey,
      ),
    );
    expect(keys.size).toBeGreaterThan(1); // different designs actually vary
  });

  it("auto only ever lands on one of the five colour keys", () => {
    const legal = new Set(BG_COLOURS.map((c) => c.key));
    for (let i = 0; i < 200; i++) expect(legal.has(resolveBackground("auto", `seed-${i}`).colourKey!)).toBe(true);
  });
});

describe("mode-aware angle prompts — the owner's own wordings", () => {
  it("minimal mode is the bare line, on every model angle and both edit engines", () => {
    for (const engine of EDIT_ENGINES) {
      for (const angle of MODEL_ANGLES) {
        expect(defaultAnglePrompt(angle, engine, { ...design, bgStyle: "minimal" })).toBe(MINIMAL);
      }
    }
  });

  it("coloured mode is the bare line plus the plate pointer", () => {
    for (const engine of EDIT_ENGINES) {
      for (const angle of MODEL_ANGLES) {
        expect(defaultAnglePrompt(angle, engine, { ...design, bgStyle: "sand" })).toBe(COLOURED);
        expect(defaultAnglePrompt(angle, engine, { ...design, bgStyle: "auto" })).toBe(COLOURED);
      }
    }
  });

  it("grey mode keeps 3 Sep's sentence structure — garment named, 'Background only'", () => {
    const p = defaultAnglePrompt("front", "seedream", { ...design, bgStyle: "grey" });
    expect(p.toLowerCase()).toContain("replace the background");
    expect(p).toContain("chanderi");
    expect(p.toLowerCase()).toContain("do not restyle");
    expect(p.toLowerCase()).toContain("background only");
    expect(p.toLowerCase()).toContain("grey studio backdrop");
    expect(p.toLowerCase()).toContain("contact shadow");
  });

  it("every model angle of one design shares ONE background treatment", () => {
    for (const style of ["minimal", "grey", "auto", "midnight"]) {
      const all = MODEL_ANGLES.map((a) => defaultAnglePrompt(a, "seedream", { ...design, bgStyle: style }));
      expect(new Set(all).size).toBe(1);
    }
  });
});

describe("detail angles never get a plate — the bench's hard-won carve-out", () => {
  it("falls back to the MINIMAL prompt in coloured mode", () => {
    for (const engine of EDIT_ENGINES) {
      for (const angle of DETAILS) {
        for (const style of ["auto", "ivory", "sand", "stone", "blush", "midnight"]) {
          const p = defaultAnglePrompt(angle, engine, { ...design, bgStyle: style });
          expect(p).toBe(MINIMAL);
          expect(p).not.toContain("attached background"); // the plate is not sent
        }
      }
    }
  });

  it("uses the minimal line in minimal mode and the macro-safe wording in grey", () => {
    expect(defaultAnglePrompt("detail_1", "seedream", { ...design, bgStyle: "minimal" })).toBe(MINIMAL);
    const grey = defaultAnglePrompt("detail_1", "openai_bg", { ...design, bgStyle: "grey" });
    expect(grey.toLowerCase()).toContain("pixel-exact");
    expect(grey.toLowerCase()).toContain("background only");
  });

  it("still gives the parked model-swap engine nothing to run on a detail", () => {
    expect(defaultAnglePrompt("detail_1", "fashn", { ...design, bgStyle: "auto" })).toBe("");
    expect(defaultAnglePrompt("detail_2", "raw", { ...design, bgStyle: "minimal" })).toBe("");
  });
});

describe("the parked model-swap brief is untouched", () => {
  it("still describes the garment and the backdrop in words (no plate to point at)", () => {
    const p = defaultAnglePrompt("front", "fashn", { ...design, bgStyle: "auto" });
    expect(p).toContain("chanderi");
    expect(p.toLowerCase()).toContain("contact shadow");
    expect(p).not.toBe(COLOURED);
  });

  it("treats lifestyle as a slot, not a scene — it differs only in framing", () => {
    const front = defaultAnglePrompt("front", "fashn", design);
    const lifestyle = defaultAnglePrompt("lifestyle", "fashn", design);
    expect(lifestyle).not.toEqual(front);
    expect(lifestyle.toLowerCase()).not.toMatch(/street|garden|cafe|outdoor|location scene/);
  });
});

describe("garment phrase", () => {
  it("prefers the human colour name over the SKU code", () => {
    expect(garmentPhrase({ ...design, colorName: "Champagne Gold" })).toBe("Champagne Gold chanderi Anarkali with gota patti");
    expect(garmentPhrase(design)).toBe("BGE chanderi Anarkali with gota patti");
    expect(garmentPhrase({})).toBe("the garment in the source photo");
  });
});

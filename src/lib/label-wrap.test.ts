import { describe, it, expect } from "vitest";
import { wrapAtHyphens } from "./label-wrap";

// Courier is monospace: at 5.4 pt one character is 0.6 em ≈ 1.143 mm, and the
// text column on a 38×25 mm tag is 16.9 mm — 14 whole characters.
const mono = (s: string) => s.length * 1.143;
const WIDTH = 16.9;

describe("wrapAtHyphens — the tag's vendor line", () => {
  it("the tag from the photo: breaks after a hyphen instead of running off", () => {
    expect(wrapAtHyphens(mono, "DR-0069-08.9-10.7", WIDTH)).toEqual(["DR-0069-08.9-", "10.7"]);
  });
  it("a code that fits stays on one line", () => {
    expect(wrapAtHyphens(mono, "CH-150-16.9-", WIDTH)).toEqual(["CH-150-16.9-"]);
    expect(wrapAtHyphens(mono, "SH-----.--03.6", WIDTH)).toEqual(["SH-----.--03.6"]);
  });
  it("never loses or reorders a character", () => {
    for (const code of ["DR-0069-08.9-10.7", "ME-MK-12-16.9-25.4", "-------.----.-", "AB-VERYLONGVENDORSKU123-01.2-03.4"]) {
      expect(wrapAtHyphens(mono, code, WIDTH).join("")).toBe(code);
    }
  });
  it("every line fits, even when one segment is wider than the label", () => {
    const lines = wrapAtHyphens(mono, "AB-VERYLONGVENDORSKU123-01.2-03.4", WIDTH);
    for (const l of lines) expect(mono(l)).toBeLessThanOrEqual(WIDTH);
    expect(lines.length).toBeGreaterThan(2);
  });
});

import { describe, it, expect } from "vitest";
import { COLOR_GROUPS, SIZES } from "./vocab";
import { unknownMintCode } from "./mint-codes";

const live = {
  colors: new Set(COLOR_GROUPS.flatMap((g) => g.items.map(([c]) => c))),
  sizes: new Set(Object.keys(SIZES)),
};
const aColor = [...live.colors][0];
const [s1, s2] = Object.keys(SIZES);

describe("unknownMintCode", () => {
  it("passes codes the vocabulary knows", () => {
    expect(unknownMintCode(live, { color: aColor, sizes: [s1, s2] })).toBeNull();
  });

  it("names an unknown colour", () => {
    expect(unknownMintCode(live, { color: "ZZZQ", sizes: [s1] })).toBe('Unknown colour code "ZZZQ"');
  });

  it("names the first unknown size, even after known ones", () => {
    expect(unknownMintCode(live, { color: aColor, sizes: [s1, "XXXXXXL9", s2] })).toBe('Unknown size code "XXXXXXL9"');
  });

  it("reports the colour before a size when both are wrong", () => {
    expect(unknownMintCode(live, { color: "ZZZQ", sizes: ["XXXXXXL9"] })).toBe('Unknown colour code "ZZZQ"');
  });

  it("checks only sizes when no colour is given", () => {
    expect(unknownMintCode(live, { sizes: [s1] })).toBeNull();
    expect(unknownMintCode(live, { sizes: ["XXXXXXL9"] })).toBe('Unknown size code "XXXXXXL9"');
  });

  it("an empty colour is not a known one", () => {
    expect(unknownMintCode(live, { color: "", sizes: [s1] })).toBe('Unknown colour code ""');
  });

  it("follows the live sets, so a code added in the portal passes and a removed one fails", () => {
    const withAdded = { colors: new Set([...live.colors, "NEWC"]), sizes: new Set([...live.sizes].filter((s) => s !== s1)) };
    expect(unknownMintCode(withAdded, { color: "NEWC", sizes: [s2] })).toBeNull();
    expect(unknownMintCode(withAdded, { color: "NEWC", sizes: [s1] })).toBe(`Unknown size code "${s1}"`);
  });
});

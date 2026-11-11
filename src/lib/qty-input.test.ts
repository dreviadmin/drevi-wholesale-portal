import { describe, expect, it } from "vitest";
import { parseQtyInput } from "./qty-input";

describe("parseQtyInput", () => {
  it("reads a typed quantity", () => {
    expect(parseQtyInput("24", 1)).toBe(24);
    expect(parseQtyInput(" 12 ", 0)).toBe(12);
    expect(parseQtyInput("007", 1)).toBe(7);
  });
  it("is null for an empty field", () => {
    expect(parseQtyInput("", 1)).toBeNull();
    expect(parseQtyInput("   ", 0)).toBeNull();
  });
  it("is null for anything that is not just digits", () => {
    expect(parseQtyInput("2a", 1)).toBeNull();
    expect(parseQtyInput("-3", 0)).toBeNull();
    expect(parseQtyInput("1.5", 1)).toBeNull();
    expect(parseQtyInput("1e3", 1)).toBeNull();
  });
  it("floors to the minimum", () => {
    expect(parseQtyInput("0", 1)).toBe(1);
    expect(parseQtyInput("0", 0)).toBe(0);
  });
  it("refuses a number too long to be a quantity", () => {
    expect(parseQtyInput("1234567890", 1)).toBeNull();
  });
});

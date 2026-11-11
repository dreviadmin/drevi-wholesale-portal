import { describe, expect, it } from "vitest";
import { parseQtyInput, parseReceiptQtyInput, QTY_MAX } from "./qty-input";

describe("parseQtyInput (buyer cart and product page)", () => {
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

describe("parseReceiptQtyInput (Log delivery and receipt edit)", () => {
  it("takes a typed whole number", () => {
    expect(parseReceiptQtyInput("24", 1)).toBe(24);
    expect(parseReceiptQtyInput("1", 30)).toBe(1);
    expect(parseReceiptQtyInput(" 7 ", 1)).toBe(7);
    expect(parseReceiptQtyInput("007", 1)).toBe(7);
  });

  it("keeps the previous quantity while the field is empty", () => {
    expect(parseReceiptQtyInput("", 12)).toBe(12);
    expect(parseReceiptQtyInput("   ", 3)).toBe(3);
  });

  it("clamps 0 and negatives to 1", () => {
    expect(parseReceiptQtyInput("0", 5)).toBe(1);
    expect(parseReceiptQtyInput("-4", 5)).toBe(1);
    expect(parseReceiptQtyInput("-0", 5)).toBe(1);
  });

  it("never reads letters as a different number", () => {
    expect(parseReceiptQtyInput("abc", 5)).toBe(1);
    expect(parseReceiptQtyInput("12abc", 5)).toBe(1);
    expect(parseReceiptQtyInput("1e3", 5)).toBe(1);
    expect(parseReceiptQtyInput("0x10", 5)).toBe(1);
    expect(parseReceiptQtyInput("Infinity", 5)).toBe(1);
  });

  it("drops a fraction rather than rounding up", () => {
    expect(parseReceiptQtyInput("2.9", 1)).toBe(2);
    expect(parseReceiptQtyInput("0.5", 4)).toBe(1);
  });

  it("caps a runaway number", () => {
    expect(parseReceiptQtyInput(String(QTY_MAX), 1)).toBe(QTY_MAX);
    expect(parseReceiptQtyInput("100000", 1)).toBe(QTY_MAX);
    expect(parseReceiptQtyInput("99999999999999999999999", 1)).toBe(QTY_MAX);
  });
});

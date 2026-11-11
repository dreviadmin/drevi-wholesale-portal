import { describe, expect, it } from "vitest";
import { cartPieces } from "./cart-count";

describe("cartPieces", () => {
  it("counts pieces, not lines: 3 + 3 reads 6", () => {
    expect(cartPieces([3, 3])).toBe(6);
  });
  it("takes the catalog's sku → qty map values", () => {
    expect(cartPieces(Object.values({ "DD-SUT-PLZ-008-M-CRM": 4, "DD-SUT-PLZ-008-L-CRM": 2 }))).toBe(6);
  });
  it("is 0 for an empty cart", () => {
    expect(cartPieces([])).toBe(0);
  });
  it("ignores zero, negative and non-numbers, and floors fractions", () => {
    expect(cartPieces([0, -2, Number.NaN, Number.POSITIVE_INFINITY, 2.7, 1])).toBe(3);
  });
});

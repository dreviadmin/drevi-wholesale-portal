import { describe, expect, it } from "vitest";
import { cartReplyToast, UNAVAILABLE_MESSAGE } from "./cart-toast";

describe("cartReplyToast", () => {
  it("says Added to cart only once the server stored the new line", () => {
    expect(cartReplyToast(0, 1, 1)).toBe("Added to cart");
    expect(cartReplyToast(0, 5, 3)).toBe("Added to cart"); // clamped, still added
  });
  it("says only the sold-out message when the server refused the size", () => {
    expect(cartReplyToast(0, 1, 0)).toBe(UNAVAILABLE_MESSAGE);
    expect(cartReplyToast(2, 3, 0)).toBe(UNAVAILABLE_MESSAGE);
  });
  it("says nothing for a line that was already in the cart", () => {
    expect(cartReplyToast(1, 2, 2)).toBeNull();
    expect(cartReplyToast(4, 3, 3)).toBeNull();
  });
  it("leaves a removal to the tap", () => {
    expect(cartReplyToast(2, 0, 0)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { canGoBackInApp, nextDepth } from "./back-nav";

describe("nextDepth", () => {
  it("counts a push as one more page behind", () => {
    expect(nextDepth(0, false)).toBe(1);
    expect(nextDepth(2, false)).toBe(3);
  });
  it("counts a pop as one fewer, never below zero", () => {
    expect(nextDepth(2, true)).toBe(1);
    expect(nextDepth(0, true)).toBe(0);
  });
  it("product from WhatsApp → cart → Back → product: nothing behind the product", () => {
    let d = 0; // the product is the first page loaded
    d = nextDepth(d, false); // tap the cart
    d = nextDepth(d, true); // Back to the product
    expect(canGoBackInApp(null, d)).toBe(false);
  });
});

describe("canGoBackInApp", () => {
  it("trusts the Navigation API when the browser has one", () => {
    expect(canGoBackInApp(0, 5)).toBe(false);
    expect(canGoBackInApp(3, 0)).toBe(true);
    expect(canGoBackInApp(-1, 2)).toBe(false);
  });
  it("falls back to the in-app count without it", () => {
    expect(canGoBackInApp(null, 0)).toBe(false);
    expect(canGoBackInApp(undefined, 1)).toBe(true);
  });
});

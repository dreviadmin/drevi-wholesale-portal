import { describe, it, expect } from "vitest";
import { portalToggleToast } from "./batch-toast";

describe("portalToggleToast", () => {
  it("says how many designs changed", () => {
    expect(portalToggleToast("shopify", false, 3)).toBe("Shopify disabled on 3 designs");
    expect(portalToggleToast("shopify", true, 3)).toBe("Shopify enabled on 3 designs");
  });

  it("uses the singular for one design", () => {
    expect(portalToggleToast("shopify", false, 1)).toBe("Shopify disabled on 1 design");
  });

  it("adds the designs that were already in that state", () => {
    expect(portalToggleToast("shopify", false, 2, 1)).toBe("Shopify disabled on 2 designs · 1 already off");
    expect(portalToggleToast("shopify", true, 0, 3)).toBe("Shopify enabled on 0 designs · 3 already on");
  });

  it("names the wholesale portal too", () => {
    expect(portalToggleToast("wholesale", true, 4)).toBe("Wholesale enabled on 4 designs");
  });
});

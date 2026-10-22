import { describe, it, expect } from "vitest";
import { designKeyOf, effectiveCompareAt, effectiveRetailPrice, specsMrp } from "./retail-price-core";

describe("effectiveRetailPrice", () => {
  it("the Specs MRP beats a stale sheet price (DD-LEH-FLR-101-L-RST, 3 Oct)", () => {
    expect(effectiveRetailPrice({ mrp_override: 14399, auto_mrp: 14399 }, 11599)).toBe(14399);
  });
  it("an override beats the auto-MRP", () => {
    expect(specsMrp({ mrp_override: "9999", auto_mrp: 8499 })).toBe(9999);
  });
  it("the saved auto-MRP counts when there is no override", () => {
    expect(effectiveRetailPrice({ mrp_override: null, auto_mrp: 42375 }, 30000)).toBe(42375);
  });
  it("the sheet fills in only when Specs has no MRP or there is no design", () => {
    expect(effectiveRetailPrice({ mrp_override: null, auto_mrp: null }, 8599)).toBe(8599);
    expect(effectiveRetailPrice({ mrp_override: 0, auto_mrp: 0 }, "8599")).toBe(8599);
    expect(effectiveRetailPrice(null, 8599)).toBe(8599);
  });
  it("no price anywhere stays null — never an invented price", () => {
    expect(effectiveRetailPrice(null, null)).toBeNull();
    expect(effectiveRetailPrice({ mrp_override: null }, 0)).toBeNull();
    expect(effectiveRetailPrice({ mrp_override: "" }, "")).toBeNull();
  });
});

describe("designKeyOf", () => {
  it("keys on base + colour whatever the size token", () => {
    expect(designKeyOf("dd-leh-flr-101-l-rst")).toBe("DD-LEH-FLR-101|RST");
    expect(designKeyOf("DD-LEH-FLR-101-FREE-SIZE-RST")).toBe("DD-LEH-FLR-101|RST");
    expect(designKeyOf("CUSTOM")).toBeNull();
  });
});

describe("effectiveCompareAt", () => {
  it("shows the compare-at price when it is above the MRP (22 Oct)", () => {
    expect(effectiveCompareAt({ compare_at_price: 18999 }, 14399)).toBe(18999);
    expect(effectiveCompareAt({ compare_at_price: "18999.00" }, 14399)).toBe(18999);
  });
  it("hides it when it is not above the price, or when either is missing", () => {
    expect(effectiveCompareAt({ compare_at_price: 14399 }, 14399)).toBeNull();
    expect(effectiveCompareAt({ compare_at_price: 12000 }, 14399)).toBeNull();
    expect(effectiveCompareAt({ compare_at_price: null }, 14399)).toBeNull();
    expect(effectiveCompareAt({ compare_at_price: 18999 }, null)).toBeNull();
    expect(effectiveCompareAt(null, 14399)).toBeNull();
  });
});

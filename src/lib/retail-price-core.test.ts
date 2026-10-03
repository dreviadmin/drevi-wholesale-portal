import { describe, it, expect } from "vitest";
import { designKeyOf, effectiveRetailPrice, specsMrp } from "./retail-price-core";

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

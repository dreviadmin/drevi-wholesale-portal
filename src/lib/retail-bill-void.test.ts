import { describe, it, expect } from "vitest";
import { lineTakesStock, voidStockNote } from "./retail-bill-void";

describe("lineTakesStock", () => {
  it("is true for a catalog line only", () => {
    expect(lineTakesStock({ sku: "DD-LEH-FLR-101-L-RST" })).toBe(true);
    expect(lineTakesStock({ sku: "DD-LEH-FLR-101-L-RST", custom: false })).toBe(true);
    expect(lineTakesStock({ sku: "ZZ-TAG-1", custom: true })).toBe(false);
    expect(lineTakesStock({ sku: "", custom: false })).toBe(false);
    expect(lineTakesStock({ sku: null })).toBe(false);
  });
});

describe("voidStockNote", () => {
  it("says stock comes back for a bill of catalog lines", () => {
    expect(voidStockNote([{ sku: "A-1" }, { sku: "B-2" }])).toBe("Stock comes back to the shelf.");
  });

  it("does not promise stock back for a bill of custom lines only", () => {
    expect(voidStockNote([{ sku: "ZZ-1", custom: true }, { sku: "", custom: true }])).toBe(
      "Custom items never took stock, so none comes back.",
    );
  });

  it("names the catalog items for a mixed bill", () => {
    expect(voidStockNote([{ sku: "A-1" }, { sku: "ZZ-1", custom: true }])).toBe(
      "Stock for its catalog items comes back to the shelf. Custom items never took stock.",
    );
  });

  it("returns nothing for a bill with no lines", () => {
    expect(voidStockNote([])).toBe("No stock comes back.");
    expect(voidStockNote(null)).toBe("No stock comes back.");
  });
});

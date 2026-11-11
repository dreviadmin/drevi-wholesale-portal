import { describe, it, expect } from "vitest";
import { mrpLabel, stockLabel, scanVerdict, readResolved } from "./scan-sheet-core";

describe("scan sheet: MRP line", () => {
  it("shows the MRP in rupees", () => {
    expect(mrpLabel({ retail_price: 4200 })).toBe("MRP ₹4,200");
  });

  it("says not set for no price, zero or a negative", () => {
    expect(mrpLabel({ retail_price: null })).toBe("MRP not set");
    expect(mrpLabel({})).toBe("MRP not set");
    expect(mrpLabel({ retail_price: 0 })).toBe("MRP not set");
    expect(mrpLabel({ retail_price: -5 })).toBe("MRP not set");
  });
});

describe("scan sheet: stock line", () => {
  it("shows the count only when the resolver sent one (admins)", () => {
    expect(stockLabel({ current_qty: 3 })).toBe("3 in stock");
    expect(stockLabel({ current_qty: 0 })).toBe("0 in stock");
    expect(stockLabel({})).toBeNull();
    expect(stockLabel({ current_qty: null })).toBeNull();
  });
});

describe("scan sheet: scanner verdict", () => {
  it("beeps success for a known tag and carries its MRP", () => {
    expect(scanVerdict({ sku: "DD-LEH-FLR-010-M-RED", known: true, retail_price: 4200 })).toEqual({
      ok: true,
      message: "DD-LEH-FLR-010-M-RED — MRP ₹4,200",
    });
    expect(scanVerdict({ sku: "DD-LEH-FLR-010-M-RED", known: true, retail_price: null }).message).toBe(
      "DD-LEH-FLR-010-M-RED — MRP not set",
    );
  });

  it("gives the failure tone for a tag the system does not know", () => {
    expect(scanVerdict({ sku: "DD-LEH-FLR-404-M-RED", known: false })).toEqual({
      ok: false,
      message: "DD-LEH-FLR-404-M-RED — Not in the system",
    });
  });
});

describe("scan sheet: reading the resolver's reply", () => {
  it("passes a known or unknown answer through", () => {
    const known = { sku: "DD-LEH-FLR-010-M-RED", known: true, retail_price: 4200, actions: [{ key: "retail_check", label: "Check retail price" }] };
    expect(readResolved(true, known)).toEqual(known);
    expect(readResolved(true, { sku: "DD-LEH-FLR-404-M-RED", known: false })).toEqual({ sku: "DD-LEH-FLR-404-M-RED", known: false, actions: [] });
  });

  it("throws on an error reply, so a signed-out or failed lookup is not called an unknown tag", () => {
    expect(() => readResolved(false, { error: "Not authorized" })).toThrow("Not authorized");
    expect(() => readResolved(true, { error: "sku required" })).toThrow("sku required");
    expect(() => readResolved(false, { sku: "X", known: false, actions: [] })).toThrow();
    expect(() => readResolved(true, null)).toThrow();
    expect(() => readResolved(true, { sku: "X" })).toThrow();
  });
});

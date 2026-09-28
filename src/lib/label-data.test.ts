import { describe, it, expect } from "vitest";
import { designKeyOf, kf, resolveLabelDatum, v2 } from "./label-data";

const vendors = new Map([["uuid-sp", "Shree Prints"], ["uuid-mk", "Meera Kalakari"]]);

describe("kf / v2 — the coded vendor line (unchanged behaviour)", () => {
  it("truncates to one decimal of thousands, never rounds", () => {
    expect(kf(1250)).toBe("01.2");
    expect(kf(12500)).toBe("12.5");
    expect(kf(1299)).toBe("01.2");
    expect(kf(0)).toBe("--.-");
    expect(kf(null)).toBe("--.-");
    expect(kf("")).toBe("--.-");
  });
  it("takes two letters of the vendor's name", () => {
    expect(v2("Shree Prints")).toBe("SH");
    expect(v2("7 A")).toBe("--");
    expect(v2(null)).toBe("--");
  });
});

describe("resolveLabelDatum — what a Studio-printed tag says", () => {
  it("a sheet-era SKU prints exactly what it printed before", () => {
    const d = resolveLabelDatum({
      sku: "DD-LEH-FLR-002-XL-IVR",
      vendorInfo: { vendor_name: "Anand Creations", vendor_sku: "AC-77", last_cost: 3400, retail_price: 8599 },
      wholesalePrice: 5200, inCatalog: true,
      design: { mrp_override: 10699, vendor_id: "uuid-sp", vendor_sku: "X" },
      vendorNameById: vendors,
    });
    expect(d).toEqual({ sku: "DD-LEH-FLR-002-XL-IVR", found: true, vendorCode: "AN-AC-77-03.4-05.2", mrp: "8,599" });
  });

  it("a Log-delivery garment: vendor from vendor_id, MRP from the design", () => {
    const d = resolveLabelDatum({
      sku: "DD-LEH-MRM-075-42-CHM",
      vendorInfo: { vendor_name: null, vendor_id: "uuid-mk", last_cost: 16950, retail_price: null },
      wholesalePrice: 0, inCatalog: true,
      design: { mrp_override: null, auto_mrp: 42375, wholesale_override: 25400, vendor_sku: "MK-12" },
      vendorNameById: vendors,
    });
    expect(d.vendorCode).toBe("ME-MK-12-16.9-25.4");
    expect(d.mrp).toBe("42,375");
  });

  it("a size minted but not yet in the catalog still prints from its design", () => {
    const d = resolveLabelDatum({
      sku: "DD-SAR-PRD-031-L-PNK", vendorInfo: null, wholesalePrice: null, inCatalog: false,
      design: { vendor_id: "uuid-sp", mrp_override: 7999, auto_wholesale: 3600 },
      vendorNameById: vendors,
    });
    expect(d).toEqual({ sku: "DD-SAR-PRD-031-L-PNK", found: true, vendorCode: "SH-----.--03.6", mrp: "7,999" });
  });

  it("the design's vendor fills in only when the vendor-info row has none", () => {
    const d = resolveLabelDatum({
      sku: "DD-X-Y-001-M-RED", vendorInfo: { vendor_id: "not-a-known-uuid" }, wholesalePrice: 100, inCatalog: true,
      design: { vendor_id: "uuid-sp" }, vendorNameById: vendors,
    });
    expect(d.vendorCode.startsWith("SH-")).toBe(true);
  });

  it("nothing anywhere → the old not-found tag", () => {
    expect(resolveLabelDatum({ sku: "DD-A-B-001-M-RED", vendorInfo: null, wholesalePrice: null, inCatalog: false, design: null, vendorNameById: vendors }))
      .toEqual({ sku: "DD-A-B-001-M-RED", found: false, vendorCode: "---------", mrp: "" });
  });

  it("an unpriced design stays honest: Rs - rather than an invented price", () => {
    const d = resolveLabelDatum({ sku: "DD-A-B-001-M-RED", vendorInfo: null, wholesalePrice: null, inCatalog: true, design: {}, vendorNameById: vendors });
    expect(d.mrp).toBe("");
    // Same shape the old route printed for an empty row: "--"-"-"-"--.-"-"--.-".
    expect(d.vendorCode).toBe("-------.----.-");
  });
});

describe("designKeyOf", () => {
  it("keys on base + colour, whatever the size token", () => {
    expect(designKeyOf("DD-LEH-MRM-075-42-CHM")).toBe("DD-LEH-MRM-075|CHM");
    expect(designKeyOf("dd-sar-prd-031-l-pnk")).toBe("DD-SAR-PRD-031|PNK");
    expect(designKeyOf("DD-LEH-MRM-075")).toBeNull();
  });
});

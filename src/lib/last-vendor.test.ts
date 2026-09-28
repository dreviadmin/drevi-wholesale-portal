import { describe, it, expect } from "vitest";
import { normaliseSheetDate, pickLastVendor, type ReceiptVendor } from "./last-vendor";

const r = (over: Partial<ReceiptVendor>): ReceiptVendor => ({
  receiptId: "r1", receiptNumber: "GR-20260801-001", receiptDate: "2026-08-01", createdAt: "2026-08-01T10:00:00Z",
  vendorId: "v1", vendorName: "Meera Kalakari", vendorSku: null, ...over,
});

describe("pickLastVendor", () => {
  it("the latest receipt wins when a design came from two vendors", () => {
    const lv = pickLastVendor({
      receipts: [
        r({ receiptId: "a", receiptNumber: "GR-20260801-001", receiptDate: "2026-08-01", vendorId: "v1", vendorName: "Meera Kalakari" }),
        r({ receiptId: "b", receiptNumber: "GR-20260915-003", receiptDate: "2026-09-15", vendorId: "v2", vendorName: "Shree Prints", vendorSku: "SP-44" }),
      ],
      sheet: [{ vendorName: "Old Sheet Vendor", vendorSku: null, lastReceiptDate: "2026-09-30" }],
      design: { vendorId: "v1", vendorName: "Meera Kalakari", vendorSku: "MK-1" },
    });
    expect(lv).toEqual({ name: "Shree Prints", vendorId: "v2", date: "2026-09-15", receiptId: "b", receiptNumber: "GR-20260915-003", vendorSku: "SP-44", source: "receipt" });
  });

  it("same-day receipts break on when they were entered", () => {
    const lv = pickLastVendor({
      receipts: [
        r({ receiptId: "a", receiptNumber: "GR-20260915-001", createdAt: "2026-09-15T09:00:00Z", receiptDate: "2026-09-15", vendorName: "First" }),
        r({ receiptId: "b", receiptNumber: "GR-20260915-002", createdAt: "2026-09-15T15:00:00Z", receiptDate: "2026-09-15", vendorId: "v9", vendorName: "Second" }),
      ],
      sheet: [], design: null,
    });
    expect(lv?.name).toBe("Second");
  });

  it("vendor SKU falls back to another line from the same vendor, then the design", () => {
    const lv = pickLastVendor({
      receipts: [
        r({ receiptId: "a", receiptDate: "2026-08-01", vendorId: "v1", vendorSku: "MK-77" }),
        r({ receiptId: "b", receiptDate: "2026-09-01", vendorId: "v1", vendorSku: null }),
      ],
      sheet: [], design: { vendorId: "v1", vendorName: "Meera Kalakari", vendorSku: "DESIGN-SKU" },
    });
    expect(lv?.receiptId).toBe("b");
    expect(lv?.vendorSku).toBe("MK-77");
  });

  it("no receipts: the sheet's most recent vendor, with its date normalised", () => {
    const lv = pickLastVendor({
      receipts: [],
      sheet: [
        { vendorName: "Anand Creations", vendorSku: "AC-1", lastReceiptDate: "15-Jul-2026" },
        { vendorName: "Older", vendorSku: null, lastReceiptDate: "2026-06-01" },
      ],
      design: null,
    });
    expect(lv).toMatchObject({ name: "Anand Creations", date: "2026-07-15", vendorSku: "AC-1", source: "sheet", vendorId: null });
  });

  it("nothing received anywhere: the design's own vendor, undated", () => {
    expect(pickLastVendor({ receipts: [], sheet: [{ vendorName: " ", vendorSku: null, lastReceiptDate: null }], design: { vendorId: "v3", vendorName: "Kala Kendra", vendorSku: null } }))
      .toEqual({ name: "Kala Kendra", vendorId: "v3", date: null, receiptId: null, receiptNumber: null, vendorSku: null, source: "design" });
  });

  it("no vendor anywhere → null, never an empty name", () => {
    expect(pickLastVendor({ receipts: [r({ vendorName: null })], sheet: [], design: { vendorId: null, vendorName: null, vendorSku: null } })).toBeNull();
  });
});

describe("normaliseSheetDate", () => {
  it("reads the three shapes the sheet wrote", () => {
    expect(normaliseSheetDate("2026-09-19")).toBe("2026-09-19");
    expect(normaliseSheetDate("5-Jul-2026")).toBe("2026-07-05");
    expect(normaliseSheetDate("46218")).toBe("2026-07-15"); // 2026-01-01 is day 46023; +195 days
    expect(normaliseSheetDate("garbage")).toBeNull();
    expect(normaliseSheetDate(null)).toBeNull();
  });
});

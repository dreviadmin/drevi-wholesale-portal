import { describe, it, expect } from "vitest";
import { mergeSheetMirror } from "./ingest-core";

// Audit round 2 (4 Oct) — the sheet only fills blanks on a design; the portal's
// Product Master values are never overwritten by the ten-minute sync.
describe("studio ingest mirror fields (mergeSheetMirror)", () => {
  const sheet = { title: "Floral Lehenga", category: "Lehengas", sub_category: "Floral", fabric: "Silk" };

  it("a brand-new design takes the sheet's values exactly as before", () => {
    expect(mergeSheetMirror(undefined, sheet)).toEqual(sheet);
    expect(mergeSheetMirror(undefined, { title: null, category: null, sub_category: null, fabric: null }))
      .toEqual({ title: null, category: null, sub_category: null, fabric: null });
  });

  it("a blank sheet cell never clears a fabric the portal holds (the finding's case)", () => {
    const out = mergeSheetMirror({ title: "Floral Lehenga", category: "Lehengas", sub_category: "Floral", fabric: "Georgette" }, { ...sheet, fabric: null });
    expect(out.fabric).toBe("Georgette");
  });

  it("a different non-blank sheet value does not overwrite the portal's either", () => {
    const out = mergeSheetMirror({ title: "Rakesh's title", category: "Sarees", sub_category: "Party", fabric: "Georgette" }, sheet);
    expect(out).toEqual({ title: "Rakesh's title", category: "Sarees", sub_category: "Party", fabric: "Georgette" });
  });

  it("fills only the fields that are blank on the design", () => {
    const out = mergeSheetMirror({ title: "Kept", category: null, sub_category: "", fabric: "   " }, sheet);
    expect(out).toEqual({ title: "Kept", category: "Lehengas", sub_category: "Floral", fabric: "Silk" });
  });

  it("blank on both sides leaves the design's value as it is", () => {
    const out = mergeSheetMirror({ title: "", category: null, sub_category: null, fabric: null }, { title: null, category: null, sub_category: null, fabric: null });
    expect(out).toEqual({ title: "", category: null, sub_category: null, fabric: null });
  });

  it("always returns every key, so a bulk upsert never nulls a column by omission", () => {
    expect(Object.keys(mergeSheetMirror({}, sheet)).sort()).toEqual(["category", "fabric", "sub_category", "title"]);
  });
});

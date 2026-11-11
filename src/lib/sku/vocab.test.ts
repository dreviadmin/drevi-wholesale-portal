import { describe, it, expect } from "vitest";
import { CATEGORIES, STAFF_CATEGORY_ORDER, orderCategories } from "./vocab";

describe("orderCategories — the staff screens' category chips", () => {
  it("puts All first, then the staff order, for the categories present", () => {
    expect(orderCategories(["Saree", "Separates", "Lehenga", "Suit Set", "Indo-Western Set"])).toEqual([
      "All", "Lehenga", "Saree", "Indo-Western Set", "Suit Set", "Separates",
    ]);
  });

  it("leaves out listed categories with no products", () => {
    expect(orderCategories(["Saree", "Lehenga"])).toEqual(["All", "Lehenga", "Saree"]);
  });

  it("sorts unlisted categories A–Z after the listed ones", () => {
    expect(orderCategories(["Kurta / Kurti", "Saree", "Gown", "Other"])).toEqual(["All", "Saree", "Gown", "Kurta / Kurti", "Other"]);
  });

  it("drops blanks and duplicates, and never repeats All", () => {
    expect(orderCategories(["Saree", null, undefined, "", "Saree", "All", "Gown"])).toEqual(["All", "Saree", "Gown"]);
    expect(orderCategories([])).toEqual(["All"]);
  });

  it("names only real categories, so no chip silently falls back to A–Z", () => {
    const names = new Set<string>(Object.values(CATEGORIES).map((c) => c.name));
    for (const c of STAFF_CATEGORY_ORDER) expect(names.has(c)).toBe(true);
  });
});

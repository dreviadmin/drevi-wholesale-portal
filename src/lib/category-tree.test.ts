import { describe, it, expect } from "vitest";

import { buildCategoryTree } from "./category-tree";
import type { WholesaleProduct } from "./types";

function row(sku: string, category: string | null, sub_category: string | null): WholesaleProduct {
  return {
    sku, category, sub_category, title: sku, description: null, color: null, primary_fabric: null,
    wholesale_price: 1000, wholesale_visible: true, buyer_visible: true, min_order_qty: null,
    current_qty: 1, restockable: true, restock_days: null, image_urls: [], hsn: null,
  } as unknown as WholesaleProduct;
}

describe("buildCategoryTree — the buyer home's Shopify-style navigation (26 Sep)", () => {
  const products = [
    // one design in two sizes: must count ONCE
    row("DD-LEH-FLR-001-M-RED", "Lehenga", "Flared / Kali"),
    row("DD-LEH-FLR-001-L-RED", "Lehenga", "Flared / Kali"),
    row("DD-LEH-FLR-002-M-BLU", "Lehenga", "Flared / Kali"),
    row("DD-LEH-MER-003-M-GRN", "Lehenga", "Mermaid"),
    row("DD-SAR-PRD-004-FS-PNK", "Saree", null),
    // no category at all: reachable through "View all" only
    row("DD-XXX-XXX-005-M-BLK", null, null),
    row("DD-XXX-XXX-006-M-BLK", "", "  "),
  ];

  it("counts designs (SKU bases), not size/colour rows", () => {
    const { totalDesigns, categories } = buildCategoryTree(products);
    expect(totalDesigns).toBe(6);
    expect(categories.find((c) => c.name === "Lehenga")?.count).toBe(3);
  });

  it("biggest category first, sub-categories nested under it, biggest first", () => {
    const { categories } = buildCategoryTree(products);
    expect(categories.map((c) => c.name)).toEqual(["Lehenga", "Saree"]);
    expect(categories[0].subs).toEqual([
      { name: "Flared / Kali", count: 2 },
      { name: "Mermaid", count: 1 },
    ]);
  });

  it("never emits an empty branch: no null/blank category, no sub-category with 0 designs", () => {
    const { categories } = buildCategoryTree(products);
    for (const c of categories) {
      expect(c.name.trim()).not.toBe("");
      expect(c.count).toBeGreaterThan(0);
      for (const s of c.subs) {
        expect(s.name.trim()).not.toBe("");
        expect(s.count).toBeGreaterThan(0);
      }
    }
    // Saree rows carry no sub-category → the category shows with no chips, not a blank chip.
    expect(categories.find((c) => c.name === "Saree")?.subs).toEqual([]);
  });

  it("an empty catalog yields an empty tree and zero designs", () => {
    expect(buildCategoryTree([])).toEqual({ totalDesigns: 0, categories: [] });
  });
});

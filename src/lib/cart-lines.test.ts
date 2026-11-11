import { describe, expect, it, vi } from "vitest";
import type { WholesaleProduct } from "./types";

// Vitest here does not resolve the @/ alias, so the real stock model is
// loaded by relative path (as in buyer-home.test.ts).
vi.mock("@/lib/stock", async () => await import("./stock"));
vi.mock("@/lib/availability", async () => await import("./availability"));
vi.mock("@/lib/variants", async () => await import("./variants"));

const { buildCartLines, cartChangeNotice, changedItemNames, cartSettlement } = await import("./cart-lines");

function product(sku: string, over: Partial<WholesaleProduct> = {}): WholesaleProduct {
  return {
    sku, title: `Title ${sku}`, description: null, category: "Lehenga", sub_category: null, color: null,
    primary_fabric: null, wholesale_price: 1000, wholesale_visible: true, buyer_visible: true, min_order_qty: null,
    current_qty: 5, restockable: true, restock_days: null, image_urls: null,
    ...over,
  } as WholesaleProduct;
}

const by = (...ps: WholesaleProduct[]) => new Map(ps.map((p) => [p.sku, p]));

describe("buildCartLines", () => {
  it("keeps an orderable line as it was stored", () => {
    const out = buildCartLines([{ sku: "A", qty: 3 }], by(product("A")));
    expect(out.lines.map((l) => [l.product.sku, l.qty, l.lineTotal])).toEqual([["A", 3, 3000]]);
    expect(out.dropped).toEqual([]);
    expect(out.adjusted).toEqual([]);
  });

  it("drops a product hidden from buyers, with its title", () => {
    const out = buildCartLines([{ sku: "A", qty: 2 }], by(product("A", { buyer_visible: false })));
    expect(out.lines).toEqual([]);
    expect(out.dropped).toEqual([{ sku: "A", title: "Title A" }]);
  });

  it("drops a sold-out product", () => {
    const out = buildCartLines([{ sku: "A", qty: 2 }], by(product("A", { current_qty: 0, restockable: false })));
    expect(out.lines).toEqual([]);
    expect(out.dropped).toEqual([{ sku: "A", title: "Title A" }]);
  });

  it("drops a SKU whose product row is gone, with no title", () => {
    const out = buildCartLines([{ sku: "GONE", qty: 1 }], by());
    expect(out.dropped).toEqual([{ sku: "GONE", title: null }]);
  });

  it("holds a Limited line to what is on hand and marks it adjusted", () => {
    const out = buildCartLines([{ sku: "A", qty: 8 }], by(product("A", { current_qty: 3, restockable: false })));
    expect(out.lines[0].qty).toBe(3);
    expect(out.lines[0].lineTotal).toBe(3000);
    expect(out.adjusted).toEqual(["A"]);
  });

  it("does not mark a Limited line within its cap", () => {
    const out = buildCartLines([{ sku: "A", qty: 3 }], by(product("A", { current_qty: 3, restockable: false })));
    expect(out.adjusted).toEqual([]);
  });

  it("never adjusts a special request", () => {
    const out = buildCartLines([{ sku: "A", qty: 8, special: true }], by(product("A", { current_qty: 3, restockable: false })));
    expect(out.lines[0].qty).toBe(8);
    expect(out.lines[0].special).toBe(true);
    expect(out.adjusted).toEqual([]);
  });

  it("keeps the stored order of the lines that stay", () => {
    const out = buildCartLines(
      [{ sku: "B", qty: 1 }, { sku: "X", qty: 1 }, { sku: "A", qty: 1 }],
      by(product("A"), product("B"), product("X", { buyer_visible: false })),
    );
    expect(out.lines.map((l) => l.product.sku)).toEqual(["B", "A"]);
  });
});

describe("cartChangeNotice", () => {
  it("is null when nothing changed", () => {
    expect(cartChangeNotice([], [])).toBeNull();
  });
  it("names one removed item", () => {
    expect(cartChangeNotice(["Rose Anarkali"], [])).toBe(
      "An item changed since you added it: Rose Anarkali is no longer available and was removed.",
    );
  });
  it("names several removed and adjusted items, with no quantities", () => {
    const text = cartChangeNotice(["A", "B", "C"], ["D"]);
    expect(text).toBe(
      "Some items changed since you added them: A, B and C are no longer available and were removed. The quantity of D was adjusted.",
    );
    expect(text).not.toMatch(/\d/);
  });
  it("words several adjusted items", () => {
    expect(cartChangeNotice([], ["D", "E"])).toBe("Some items changed since you added them: The quantities of D and E were adjusted.");
  });
});

describe("changedItemNames", () => {
  it("uses the title, or the SKU when the product row is gone", () => {
    expect(changedItemNames([{ sku: "DD-ANK-STR-001-M-RED", title: "Rose Anarkali" }, { sku: "GONE-1", title: null }])).toEqual([
      "Rose Anarkali",
      "GONE-1",
    ]);
  });
  it("adds size and colour when two changed items share a title", () => {
    const names = changedItemNames([
      { sku: "DD-ANK-STR-001-M-CRM", title: "Rose Anarkali" },
      { sku: "DD-ANK-STR-001-L-CRM", title: "Rose Anarkali" },
      { sku: "DD-GWN-FLR-002-S-RED", title: "Ruby Gown" },
    ]);
    expect(names).toEqual(["Rose Anarkali (M · Cream)", "Rose Anarkali (L · Cream)", "Ruby Gown"]);
    expect(cartChangeNotice(names.slice(0, 2), names.slice(2))).toBe(
      "Some items changed since you added them: Rose Anarkali (M · Cream) and Rose Anarkali (L · Cream) are no longer available and were removed. The quantity of Ruby Gown was adjusted.",
    );
  });
  it("tells a shared title apart by SKU when the SKU carries no size", () => {
    expect(changedItemNames([{ sku: "CUSTOM-1", title: "Sample" }, { sku: "CUSTOM-2", title: "Sample" }])).toEqual([
      "Sample (CUSTOM-1)",
      "Sample (CUSTOM-2)",
    ]);
  });
  it("is empty for nothing changed", () => {
    expect(changedItemNames([])).toEqual([]);
  });
});

// The cart page's settle step deletes every row it is handed as dropped. A
// failed product read used to hand it every row (Nov review).
describe("cartSettlement", () => {
  it("refuses a cart that could not be read rather than naming its rows dropped", () => {
    expect(() => cartSettlement({ lines: [], dropped: [], adjusted: [], readFailed: true })).toThrow("could not be read");
  });

  it("settles what really changed: the dropped rows, and adjusted lines at the number shown", () => {
    const out = buildCartLines(
      [{ sku: "A", qty: 2 }, { sku: "GONE", qty: 1 }, { sku: "LTD", qty: 8 }],
      by(product("A"), product("LTD", { current_qty: 3, restockable: false })),
    );
    const s = cartSettlement(out);
    expect(s.droppedSkus).toEqual(["GONE"]);
    expect(s.adjustedLines).toEqual([{ sku: "LTD", qty: 3 }]);
    expect(s.changeNotice).toBe("Some items changed since you added them: GONE is no longer available and was removed. The quantity of Title LTD was adjusted.");
  });

  it("settles nothing for a cart with no changes, or no cart", () => {
    expect(cartSettlement(buildCartLines([{ sku: "A", qty: 2 }], by(product("A"))))).toEqual({ changeNotice: null, droppedSkus: [], adjustedLines: [] });
    expect(cartSettlement(null)).toEqual({ changeNotice: null, droppedSkus: [], adjustedLines: [] });
  });
});

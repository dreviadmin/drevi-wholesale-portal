import { describe, it, expect, vi, beforeEach } from "vitest";

// loadBuyerHome reads four tables. A small fake admin client answers each one
// from the fixtures below, so the home page's own rules (what counts as new
// this week, how many tiles it gets) run for real.

let tables: Record<string, unknown[]> = {};

function fakeAdmin() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain, eq: chain, neq: chain, is: chain, gte: chain, in: chain, order: chain, limit: chain,
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          return Promise.resolve({ data: tables[table] ?? [], error: null }).then(res, rej);
        },
      });
      return b;
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
// Vitest here does not resolve the @/ alias, so the real modules are loaded by
// relative path.
vi.mock("@/lib/types", async () => await import("./types"));
vi.mock("@/lib/category-tree", async () => await import("./category-tree"));

const { loadBuyerHome } = await import("./buyer-home");

function product(sku: string) {
  return {
    sku, title: sku, category: "Lehenga", sub_category: "Flared / Kali", wholesale_price: 1000,
    buyer_visible: true, min_order_qty: null, current_qty: 2, restockable: true, image_urls: [`https://img.test/${sku}.jpg`],
  };
}

const recently = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  tables = { orders: [], notify_me: [], wholesale_products: [], product_images: [] };
});

describe("loadBuyerHome: New this week", () => {
  it("shows one tile per design and colour, not one per size", async () => {
    tables.wholesale_products = [
      product("DD-LEH-FLR-001-S-RED"),
      product("DD-LEH-FLR-001-M-RED"),
      product("DD-LEH-FLR-001-L-RED"),
      product("DD-LEH-FLR-001-XL-RED"),
      product("DD-LEH-FLR-002-M-BLU"),
      product("DD-LEH-FLR-002-L-BLU"),
    ];
    tables.product_images = [
      { sku_base: "DD-LEH-FLR-001", color: "RED", published_at: recently },
      { sku_base: "DD-LEH-FLR-002", color: "BLU", published_at: recently },
    ];
    const home = await loadBuyerHome("buyer-1");
    expect(home.newThisWeek.map((p) => p.sku)).toEqual(["DD-LEH-FLR-001-S-RED", "DD-LEH-FLR-002-M-BLU"]);
  });

  it("keeps two colours of one design as two tiles", async () => {
    tables.wholesale_products = [
      product("DD-LEH-FLR-001-M-RED"),
      product("DD-LEH-FLR-001-L-RED"),
      product("DD-LEH-FLR-001-M-GRN"),
    ];
    tables.product_images = [
      { sku_base: "DD-LEH-FLR-001", color: "RED", published_at: recently },
      { sku_base: "dd-leh-flr-001", color: "grn", published_at: recently },
    ];
    const home = await loadBuyerHome("buyer-1");
    expect(home.newThisWeek.map((p) => p.sku)).toEqual(["DD-LEH-FLR-001-M-RED", "DD-LEH-FLR-001-M-GRN"]);
  });

  it("leaves out designs that were not published this week", async () => {
    tables.wholesale_products = [product("DD-LEH-FLR-001-M-RED"), product("DD-LEH-FLR-009-M-RED")];
    tables.product_images = [{ sku_base: "DD-LEH-FLR-001", color: "RED", published_at: recently }];
    const home = await loadBuyerHome("buyer-1");
    expect(home.newThisWeek.map((p) => p.sku)).toEqual(["DD-LEH-FLR-001-M-RED"]);
  });

  it("fills its 8 tiles with 8 different designs when more are fresh", async () => {
    const designs = Array.from({ length: 10 }, (_, i) => `DD-LEH-FLR-${String(i + 1).padStart(3, "0")}`);
    tables.wholesale_products = designs.flatMap((d) => ["S", "M", "L", "XL"].map((s) => product(`${d}-${s}-RED`)));
    tables.product_images = designs.map((d) => ({ sku_base: d, color: "RED", published_at: recently }));
    const home = await loadBuyerHome("buyer-1");
    expect(home.newThisWeek).toHaveLength(8);
    const groups = new Set(home.newThisWeek.map((p) => p.sku.split("-").slice(0, 4).join("-")));
    expect(groups.size).toBe(8);
  });
});

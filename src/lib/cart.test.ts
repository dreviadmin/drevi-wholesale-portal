/* eslint-disable @typescript-eslint/no-explicit-any -- the fake query builder is untyped on purpose */
import { describe, it, expect, vi, beforeEach } from "vitest";

// getDetailedCart reads two tables: the stored cart row, then the products in
// it. A small fake admin client answers both, and either read can be made to
// fail the way PostgREST does (data null, an error, no throw).

let carts: Record<string, unknown[]> = {};
let products: Record<string, any>[] = [];
let failing = new Set<string>();

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let one = false;
      const b: any = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
        in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; },
        maybeSingle: () => { one = true; return b; },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          if (failing.has(table)) return Promise.resolve({ data: null, error: { message: `${table} timed out` } }).then(res, rej);
          const rows = table === "carts"
            ? Object.entries(carts).map(([buyer_id, items]) => ({ buyer_id, items }))
            : table === "wholesale_products" ? products : [];
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: one ? hit[0] ?? null : hit, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
// Vitest here does not resolve the @/ alias, so the real modules are loaded by
// relative path.
vi.mock("@/lib/types", async () => await import("./types"));
vi.mock("@/lib/cart-lines", async () => await import("./cart-lines"));
vi.mock("@/lib/stock", async () => await import("./stock"));
vi.mock("@/lib/availability", async () => await import("./availability"));
vi.mock("@/lib/variants", async () => await import("./variants"));

const { getDetailedCart, getRawCart } = await import("./cart");

function product(sku: string, over: Record<string, unknown> = {}) {
  return {
    sku, title: `Title ${sku}`, category: "Lehenga", sub_category: null, wholesale_price: 1000, buyer_visible: true,
    min_order_qty: null, current_qty: 5, restockable: true, restock_days: null, image_urls: null, ...over,
  };
}

beforeEach(() => {
  carts = { b1: [{ sku: "A", qty: 2 }, { sku: "B", qty: 3 }, { sku: "C", qty: 1 }] };
  products = [product("A"), product("B"), product("C")];
  failing = new Set();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getDetailedCart when a read fails (Nov review)", () => {
  it("a failed product read says so and names nothing as dropped, so the cart page deletes nothing", async () => {
    failing.add("wholesale_products");
    const cart = await getDetailedCart("b1");
    expect(cart.readFailed).toBe(true);
    expect(cart.dropped).toEqual([]);
    expect(cart.adjusted).toEqual([]);
    expect(cart.lines).toEqual([]);
  });

  it("a failed cart read says so too, and does not throw (the product page has no error page)", async () => {
    failing.add("carts");
    const cart = await getDetailedCart("b1");
    expect(cart).toMatchObject({ readFailed: true, lines: [], dropped: [], totalQty: 0 });
  });

  it("a read that worked still drops a sold-out row, and reports no failure", async () => {
    products = [product("A"), product("B", { current_qty: 0, restockable: false }), product("C")];
    const cart = await getDetailedCart("b1");
    expect(cart.readFailed).toBeFalsy();
    expect(cart.dropped).toEqual([{ sku: "B", title: "Title B" }]);
    expect(cart.lines.map((l) => l.product.sku)).toEqual(["A", "C"]);
    expect(cart.totalQty).toBe(3);
  });

  it("an empty cart is just empty", async () => {
    carts = {};
    expect(await getDetailedCart("b1")).toMatchObject({ lines: [], dropped: [], totalQty: 0 });
    expect((await getDetailedCart("b1")).readFailed).toBeFalsy();
  });
});

describe("getRawCart", () => {
  it("throws when the read fails instead of passing for an empty cart, so no write saves over it", async () => {
    failing.add("carts");
    await expect(getRawCart("b1")).rejects.toThrow("Cart read failed: carts timed out");
  });

  it("reads the stored rows", async () => {
    expect(await getRawCart("b1")).toEqual([
      { sku: "A", qty: 2, special: false },
      { sku: "B", qty: 3, special: false },
      { sku: "C", qty: 1, special: false },
    ]);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- the fake query builder is untyped on purpose */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The buyer cart actions against a small in-memory database: carts, products,
// buyers and orders. Supabase, Next and the order side effects are faked; the
// cart model (src/lib/cart.ts, cart-lines.ts, stock.ts) is the real one.

type Row = Record<string, any>;
let db: Record<string, Row[]> = {};
let failing = new Set<string>();
let writes: { table: string; op: string }[] = [];

function fakeAdmin() {
  return {
    rpc: async () => ({ data: "DW-20261111-001", error: null }),
    from(table: string) {
      let op = "select";
      let payload: any;
      let one = false;
      let returning = false;
      const tests: ((r: Row) => boolean)[] = [];
      const b: any = {
        select: () => { if (op !== "select") returning = true; return b; },
        insert: (p: Row) => { op = "insert"; payload = p; return b; },
        upsert: (p: Row) => { op = "upsert"; payload = p; return b; },
        eq: (k: string, v: unknown) => { tests.push((r) => r[k] === v); return b; },
        in: (k: string, vs: unknown[]) => { tests.push((r) => vs.includes(r[k])); return b; },
        not: (k: string, _o: string, v: unknown) => { tests.push((r) => (r[k] ?? null) !== v); return b; },
        limit: () => b,
        maybeSingle: () => { one = true; return b; },
        single: () => { one = true; return b; },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          return Promise.resolve().then(run).then(res, rej);
        },
      };
      const rows = () => (db[table] ??= []);
      function run() {
        if (op === "select") {
          if (failing.has(table)) return { data: null, error: { message: `${table} timed out` } };
          const hit = structuredClone(rows().filter((r) => tests.every((t) => t(r))));
          return { data: one ? hit[0] ?? null : hit, error: null };
        }
        writes.push({ table, op });
        if (op === "upsert") {
          const hit = rows().find((r) => r.buyer_id === payload.buyer_id);
          if (hit) Object.assign(hit, structuredClone(payload));
          else rows().push(structuredClone(payload));
          return { data: null, error: null };
        }
        const row = { id: `${table}-${rows().length + 1}`, ...structuredClone(payload) };
        rows().push(row);
        return { data: returning ? (one ? row : [row]) : null, error: null };
      }
      return b;
    },
  };
}

const redirect = vi.fn((to: string) => { throw new Error(`redirect ${to}`); });
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: () => ({ auth: { getUser: async () => ({ data: { user: { email: "shop@example.test" } } }) } }),
}));
vi.mock("@/lib/order-finalize", () => ({ finalizeOrder: async () => ({}) }));
vi.mock("@/lib/buyer-snapshot", () => ({ captureBuyerSnapshot: async () => ({}) }));
// Vitest here does not resolve the @/ alias, so the real modules are loaded by
// relative path.
vi.mock("@/lib/hsn-default", async () => await import("../../lib/hsn-default"));
vi.mock("@/lib/cart", async () => await import("../../lib/cart"));
vi.mock("@/lib/cart-lines", async () => await import("../../lib/cart-lines"));
vi.mock("@/lib/cart-count", async () => await import("../../lib/cart-count"));
vi.mock("@/lib/stock", async () => await import("../../lib/stock"));
vi.mock("@/lib/availability", async () => await import("../../lib/availability"));
vi.mock("@/lib/variants", async () => await import("../../lib/variants"));
vi.mock("@/lib/types", async () => await import("../../lib/types"));

const actions = await import("./actions");

function product(sku: string, over: Row = {}): Row {
  return {
    sku, title: `Title ${sku}`, category: "Lehenga", sub_category: null, wholesale_price: 1000, buyer_visible: true,
    min_order_qty: null, current_qty: 5, restockable: true, restock_days: null, image_urls: null, hsn: "6204", ...over,
  };
}
const cartOf = () => db.carts.find((c) => c.buyer_id === "b1")?.items as Row[] | undefined;

beforeEach(() => {
  db = {
    buyers: [{ id: "b1", email: "shop@example.test", status: "active", encrypted_password: "x" }],
    carts: [],
    wholesale_products: [],
    orders: [],
  };
  failing = new Set();
  writes = [];
  redirect.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("addToCart counts pieces the way every other screen does (Nov review)", () => {
  it("leaves out a stored row that has sold out since, so 4 + 1 reads 5, not 15", async () => {
    db.wholesale_products = [product("OK"), product("GONE", { current_qty: 0, restockable: false })];
    db.carts = [{ buyer_id: "b1", items: [{ sku: "GONE", qty: 10 }, { sku: "OK", qty: 4 }] }];
    const res = await actions.addToCart("OK", 1);
    expect(res).toMatchObject({ ok: true, pieces: 5 });
  });

  it("counts a Limited row stored above its stock at what is on hand", async () => {
    db.wholesale_products = [product("LTD", { current_qty: 3, restockable: false }), product("OK")];
    db.carts = [{ buyer_id: "b1", items: [{ sku: "LTD", qty: 8 }, { sku: "OK", qty: 2 }] }];
    const res = await actions.addToCart("OK", 1);
    expect(res).toMatchObject({ ok: true, pieces: 3 + 3 });
  });

  it("says the same count when it refuses a size that is gone", async () => {
    db.wholesale_products = [product("OK"), product("GONE", { current_qty: 0, restockable: false })];
    db.carts = [{ buyer_id: "b1", items: [{ sku: "GONE", qty: 10 }, { sku: "OK", qty: 4 }] }];
    const res = await actions.addToCart("GONE", 1);
    expect(res).toMatchObject({ ok: false, pieces: 4 });
  });
});

describe("a failed read is never an empty cart (Nov review)", () => {
  it("submit says the cart could not be loaded, orders nothing and clears nothing", async () => {
    db.wholesale_products = [product("A")];
    db.carts = [{ buyer_id: "b1", items: [{ sku: "A", qty: 2 }] }];
    failing.add("wholesale_products");
    const fd = new FormData();
    const res = await actions.submitOrder({}, fd);
    expect(res.error).toBe("Your cart could not be loaded just now. Please try again.");
    expect(db.orders).toHaveLength(0);
    expect(cartOf()).toEqual([{ sku: "A", qty: 2 }]);
  });

  it("a quantity save whose cart read fails throws and writes nothing, so the other lines stay", async () => {
    db.wholesale_products = [product("A"), product("B")];
    db.carts = [{ buyer_id: "b1", items: [{ sku: "A", qty: 2 }, { sku: "B", qty: 3 }] }];
    failing.add("carts");
    await expect(actions.setQty("A", 5)).rejects.toThrow("Cart read failed");
    await expect(actions.removeFromCart("A")).rejects.toThrow("Cart read failed");
    await expect(actions.addToCart("A", 1)).rejects.toThrow("Cart read failed");
    expect(writes).toEqual([]);
    expect(cartOf()).toEqual([{ sku: "A", qty: 2 }, { sku: "B", qty: 3 }]);
  });
});

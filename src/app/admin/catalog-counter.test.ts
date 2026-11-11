/* eslint-disable @typescript-eslint/no-explicit-any -- the fake query builder is untyped on purpose */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Manage Catalog, the retail counter, the exhibition wizard's submit, the LoV
// editor and the global scan resolver, run against a small in-memory database
// that honours each query's filters. The stock ledger is the REAL module, so a
// rename's carry and the sale after it go through the same arithmetic the app
// uses; only Supabase, Next, storage, PDFs and messaging are faked.

type Row = Record<string, any>;
let db: Record<string, Row[]> = {};
let failInsert: ((table: string, row: Row) => string | null) | null = null;
let failSelect: ((table: string) => string | null) | null = null;
let nextId = 0;
let clock = 0;
const stamp = () => new Date(Date.UTC(2026, 10, 10, 6, 0, 0) + ++clock * 1000).toISOString();

function fakeAdmin() {
  return {
    rpc: async (name: string) =>
      name === "next_order_number" ? { data: `DX-20261110-${String(++nextId).padStart(3, "0")}`, error: null } : { data: null, error: { message: `no rpc ${name}` } },
    from(table: string) {
      let op: "select" | "update" | "insert" | "upsert" | "delete" = "select";
      let payload: any;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      let returning = false;
      let one: "maybe" | "single" | null = null;
      let sort: { key: string; asc: boolean } | null = null;
      let count = false;
      let head = false;
      const tests: ((r: Row) => boolean)[] = [];
      const b: any = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          if (op !== "select") returning = true;
          count = !!opts?.count;
          head = !!opts?.head;
          return b;
        },
        update(p: Row) { op = "update"; payload = p; return b; },
        insert(p: Row | Row[]) { op = "insert"; payload = p; return b; },
        upsert(p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) { op = "upsert"; payload = p; upsertOpts = o ?? {}; return b; },
        delete() { op = "delete"; return b; },
        eq(k: string, v: unknown) { tests.push((r) => r[k] === v); return b; },
        is(k: string, v: unknown) { tests.push((r) => (r[k] ?? null) === v); return b; },
        in(k: string, vs: unknown[]) { tests.push((r) => vs.includes(r[k])); return b; },
        not(k: string, _o: string, v: unknown) { tests.push((r) => (r[k] ?? null) !== v); return b; },
        order(k: string, o?: { ascending?: boolean }) { sort = { key: k, asc: o?.ascending !== false }; return b; },
        limit() { return b; },
        maybeSingle() { one = "maybe"; return b; },
        single() { one = "single"; return b; },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          return Promise.resolve().then(run).then(res, rej);
        },
      };
      const rows = () => (db[table] ??= []);
      const match = () => rows().filter((r) => tests.every((t) => t(r)));
      const shape = (list: Row[]) => {
        const copy = structuredClone(list);
        if (one) return { data: copy[0] ?? null, error: one === "single" && !copy[0] ? { message: "no rows" } : null };
        return { data: copy, error: null };
      };
      const fresh = (p: Row): Row => ({
        id: `${table}-${++nextId}`,
        ...(table === "stock_movements" ? { created_at: stamp() } : {}),
        ...structuredClone(p),
      });
      function run() {
        if (op === "select") {
          const why = failSelect?.(table);
          if (why) return { data: null, error: { message: why } };
          let list = match();
          if (sort) {
            const { key, asc } = sort;
            list = [...list].sort((x, y) => (x[key] < y[key] ? -1 : x[key] > y[key] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (count && head) return { data: null, count: list.length, error: null };
          return shape(list);
        }
        if (op === "update") {
          const hit = match();
          for (const r of hit) Object.assign(r, structuredClone(payload));
          return returning ? shape(hit) : { data: null, error: null };
        }
        if (op === "insert") {
          const list = (Array.isArray(payload) ? payload : [payload]).map(fresh);
          for (const r of list) {
            const why = failInsert?.(table, r);
            if (why) return { data: null, error: { message: why } };
          }
          if (table === "wholesale_products" && list.some((n) => rows().some((r) => r.sku === n.sku))) {
            return { data: null, error: { message: "duplicate key", code: "23505" } };
          }
          rows().push(...list);
          return returning ? shape(list) : { data: null, error: null };
        }
        if (op === "upsert") {
          const keys = (upsertOpts.onConflict ?? "sku").split(",").map((k) => k.trim());
          const out: Row[] = [];
          for (const p of Array.isArray(payload) ? payload : [payload]) {
            const hit = rows().find((r) => keys.every((k) => r[k] === p[k]));
            if (hit) {
              if (!upsertOpts.ignoreDuplicates) Object.assign(hit, structuredClone(p));
              out.push(hit);
            } else {
              const n = fresh(p);
              rows().push(n);
              out.push(n);
            }
          }
          return returning ? shape(out) : { data: null, error: null };
        }
        const hit = match();
        db[table] = rows().filter((r) => !hit.includes(r));
        return { data: null, error: null };
      }
      return b;
    },
  };
}

const STAFF = { id: "staff-1", email: "rakesh@drevifashion.com", name: "Rakesh", role: "super_admin" as const };
const writeAuditEvent = vi.fn(async (e: Record<string, unknown>) => { void e; });
const uploadProductPhoto = vi.fn(async (sku: string) => `https://cdn.example.test/product-photos/${sku}/0.jpg`);

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock("@/lib/staff", () => ({
  requireAdmin: async () => STAFF,
  requireStaff: async () => STAFF,
  getStaff: async () => STAFF,
  isAdminRole: (r: string) => r === "admin" || r === "super_admin",
}));
vi.mock("@/lib/audit", () => ({ writeAuditEvent: (e: Record<string, unknown>) => writeAuditEvent(e) }));
vi.mock("@/lib/storage", () => ({
  uploadProductPhoto: (sku: string) => uploadProductPhoto(sku),
  uploadCustomItemImage: async () => "https://cdn.example.test/custom.jpg",
  uploadOrderPdf: async () => "https://cdn.example.test/bill.pdf",
}));
vi.mock("@/lib/order-finalize", () => ({ finalizeOrder: async () => ({}) }));
vi.mock("@/lib/order-pdf", () => ({ renderOrderPdf: async () => new Uint8Array() }));
vi.mock("@/lib/interakt", () => ({ sendPendingReviewAlert: async () => {} }));
vi.mock("@/lib/buyer-snapshot", () => ({ captureBuyerSnapshot: async () => ({}), snapshotSourceForDate: () => "live" }));
vi.mock("@/lib/retail-price", () => ({ loadRetailPrices: async () => ({ sheetSkus: [] }) }));
vi.mock("@/lib/stock", () => ({
  getStockState: (p: { current_qty: number; restockable: boolean }) => (p.current_qty > 0 ? "ready" : p.restockable ? "made_to_order" : "sold_out"),
}));
// Vitest here does not resolve the @/ alias, so the real modules are loaded
// by relative path.
vi.mock("@/lib/stock-ledger", async () => await import("../../lib/stock-ledger"));
vi.mock("@/lib/supabase/fetch-all", async () => await import("../../lib/supabase/fetch-all"));
vi.mock("@/lib/order-lines-core", async () => await import("../../lib/order-lines-core"));
vi.mock("@/lib/custom-catalog", async () => await import("../../lib/custom-catalog"));
vi.mock("@/lib/hsn-default", async () => await import("../../lib/hsn-default"));
vi.mock("@/lib/sku/lov-code", async () => await import("../../lib/sku/lov-code"));
vi.mock("@/lib/retail-price-core", async () => await import("../../lib/retail-price-core"));
vi.mock("@/lib/dashboard/lines", async () => await import("../../lib/dashboard/lines"));
vi.mock("@/lib/pricing", async () => await import("../../lib/pricing"));
vi.mock("@/lib/studio/copy-prompt", async () => await import("../../lib/studio/copy-prompt"));

const catalog = await import("./manage-catalog/actions");
const retail = await import("./retail-bill/actions");
const exhibition = await import("./exhibition/actions");
const lovs = await import("./lovs/actions");
const scan = await import("../api/scan/resolve/route");
const ledger = await import("../../lib/stock-ledger");
const master = await import("./studio/master/[designId]/actions");
const { canonicalBySku, sheetSyncQty } = await import("../../lib/stock-ledger-core");

const OLD = "DD-LEH-FLR-010-M-RED";
const NEW = "DD-LEH-FLR-011-M-RED";

function product(sku: string, over: Row = {}): Row {
  return {
    sku, title: "Floral lehenga", current_qty: 0, locked_fields: [], image_urls: [], wholesale_price: 2500,
    wholesale_visible: true, restockable: false, restock_days: null, hsn: "6204", ...over,
  };
}
const move = (sku: string, over: Row): Row => ({
  id: `m-${++nextId}`, sku, delta: 0, snapshot_qty: null, reason: "correction", ref_type: null, ref_id: null,
  note: null, created_by: "test", created_at: stamp(), ...over,
});
const productRow = (sku: string) => db.wholesale_products.find((p) => p.sku === sku);
const movesFor = (sku: string) => db.stock_movements.filter((m) => m.sku === sku);
const lastAudit = () => String(writeAuditEvent.mock.calls.at(-1)?.[0]?.notes ?? "");

beforeEach(() => {
  db = { wholesale_products: [], stock_movements: [], product_vendor_info: [], sync_ignored_skus: [], lovs: [], sku_registry: [], designs: [], retail_bills: [], orders: [], exhibition_sessions: [] };
  failInsert = null;
  failSelect = null;
  nextId = 0;
  clock = 0;
  writeAuditEvent.mockClear();
  uploadProductPhoto.mockClear();
});

describe("renameProductSku carries the stock ledger", () => {
  it("keeps the count, so the next sale on the new SKU subtracts from it instead of resetting", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 5 })];
    db.stock_movements = [
      move(OLD, { reason: "reset", snapshot_qty: 3, note: "migration opening balance" }),
      move(OLD, { reason: "receipt", delta: 4 }),
      move(OLD, { reason: "order", delta: -2 }),
    ];
    const r = await catalog.renameProductSku(OLD, NEW.toLowerCase());
    expect(r).toEqual({ ok: true });
    expect(productRow(NEW)?.current_qty).toBe(5);
    expect(productRow(OLD)).toBeUndefined();

    const carry = movesFor(NEW);
    expect(carry).toHaveLength(1);
    expect(carry[0]).toMatchObject({ delta: 5, reason: "correction", ref_type: "rename" });
    expect(carry[0].note).toContain(OLD);
    // The old SKU's history is left as it is: orders, bills and receipts still name it.
    expect(movesFor(OLD)).toHaveLength(3);

    const sale = await ledger.applyMovement({ sku: NEW, delta: -1, reason: "order" });
    expect(sale.stock).toBe(4);
    expect(productRow(NEW)?.current_qty).toBe(4);
    expect(db.sync_ignored_skus).toEqual([expect.objectContaining({ sku: OLD })]);
    expect(productRow(NEW)?.locked_fields).toContain("sku");
  });

  it("renaming back takes the live SKU off the sync ignore list", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 4 })];
    expect((await catalog.renameProductSku(OLD, NEW)).ok).toBe(true);
    expect(db.sync_ignored_skus.map((r) => r.sku)).toEqual([OLD]);
    expect((await catalog.renameProductSku(NEW, OLD)).ok).toBe(true);
    // OLD is the live SKU again, so only NEW (now gone) stays ignored.
    expect(db.sync_ignored_skus.map((r) => r.sku)).toEqual([NEW]);
  });

  it("carries the shown count when the old SKU has no ledger history at all", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 7 })];
    const r = await catalog.renameProductSku(OLD, NEW);
    expect(r.ok).toBe(true);
    expect(movesFor(NEW)).toEqual([expect.objectContaining({ delta: 7, reason: "correction", ref_type: "rename" })]);
    const sale = await ledger.applyMovement({ sku: NEW, delta: -1, reason: "order" });
    expect(sale.stock).toBe(6);
    expect(lastAudit()).toContain("no ledger yet");
  });

  it("follows the ledger when it and the screen disagree, and notes both", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 12 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 5 })];
    await catalog.renameProductSku(OLD, NEW);
    expect(productRow(NEW)?.current_qty).toBe(5);
    expect(lastAudit()).toContain("ledger 5 pc");
    expect(lastAudit()).toContain("screen showed 12 pc");
  });

  it("anchors the new SKU at the ledger's 0 when the screen showed more, so its first sale does not seed the screen's count", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 3 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 0 })];
    await catalog.renameProductSku(OLD, NEW);
    expect(movesFor(NEW)).toEqual([expect.objectContaining({ delta: 0, reason: "correction", ref_type: "rename" })]);
    expect(productRow(NEW)?.current_qty).toBe(0);
    const sale = await ledger.applyMovement({ sku: NEW, delta: -1, reason: "order" });
    expect(sale.stock).toBe(-1);
    expect(movesFor(NEW).some((m) => m.ref_type === "opening_balance")).toBe(false);
  });

  it("writes no movement when there is nothing to carry", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 0 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 0 })];
    const r = await catalog.renameProductSku(OLD, NEW);
    expect(r.ok).toBe(true);
    expect(movesFor(NEW)).toHaveLength(0);
  });

  it("lands on the right count when renamed back to a name that still has its own ledger", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 10 })];
    await catalog.renameProductSku(OLD, NEW);
    await ledger.applyMovement({ sku: NEW, delta: -2, reason: "order" });
    expect(productRow(NEW)?.current_qty).toBe(8);

    await catalog.renameProductSku(NEW, OLD);
    expect(productRow(OLD)?.current_qty).toBe(8);
    expect(await ledger.canonicalStock(OLD)).toBe(8);
    expect(movesFor(OLD).at(-1)).toMatchObject({ delta: -2, ref_type: "rename" });
  });

  it("keeps a negative balance honest", async () => {
    db.wholesale_products = [product(OLD, { current_qty: -2 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 1 }), move(OLD, { reason: "order", delta: -3 })];
    await catalog.renameProductSku(OLD, NEW);
    expect(productRow(NEW)?.current_qty).toBe(-2);
    expect(movesFor(NEW)[0]).toMatchObject({ delta: -2, reason: "correction" });
  });

  it("copies the vendor and retail row, never overwriting one the new SKU already has", async () => {
    db.wholesale_products = [product(OLD)];
    db.product_vendor_info = [{ sku: OLD, vendor_name: "Surat Silks", vendor_sku: "SS-77", last_cost: 900, retail_price: 4200, locked_fields: [] }];
    await catalog.renameProductSku(OLD, NEW);
    expect(db.product_vendor_info.find((v) => v.sku === NEW)).toMatchObject({ vendor_sku: "SS-77", retail_price: 4200 });
    expect(db.product_vendor_info.find((v) => v.sku === OLD)).toBeTruthy();
    expect(lastAudit()).toContain("vendor info copied");

    db.wholesale_products = [product("DD-LEH-FLR-012-M-RED")];
    db.product_vendor_info.push({ sku: "DD-LEH-FLR-012-M-RED", vendor_sku: "OLDER", retail_price: 1 });
    db.product_vendor_info.push({ sku: "DD-LEH-FLR-013-M-RED", vendor_sku: "KEEP-ME", retail_price: 3100 });
    await catalog.renameProductSku("DD-LEH-FLR-012-M-RED", "DD-LEH-FLR-013-M-RED");
    expect(db.product_vendor_info.find((v) => v.sku === "DD-LEH-FLR-013-M-RED")).toMatchObject({ vendor_sku: "KEEP-ME", retail_price: 3100 });
  });

  it("reports a carry that failed instead of swallowing it", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 5 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 5 })];
    failInsert = (table) => (table === "stock_movements" ? "insert refused" : null);
    const r = await catalog.renameProductSku(OLD, NEW);
    // The rename itself stands, so the result is ok with a warning (the modal
    // shows it as an alert), not a failure that would keep the modal on the old SKU.
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.warning).toContain(`Renamed to ${NEW}`);
    expect(r.warning).toContain("stock did NOT carry over");
    expect(r.warning).toContain("set 5 pc in Stock take");
    expect(productRow(NEW)).toBeTruthy();
    expect(productRow(OLD)).toBeUndefined();
  });

  it("gives no warning when everything carried", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 5 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 5 })];
    expect(await catalog.renameProductSku(OLD, NEW)).toEqual({ ok: true });
  });

  it("still refuses a clash, a bad shape and a missing product", async () => {
    db.wholesale_products = [product(OLD), product(NEW)];
    expect((await catalog.renameProductSku(OLD, NEW)).error).toContain("already exists");
    expect((await catalog.renameProductSku(OLD, "DD LEH")).error).toContain("letters, digits and hyphens");
    expect((await catalog.renameProductSku("DD-NOPE-001", "DD-NOPE-002")).error).toBe("Product not found.");
    expect(db.stock_movements).toHaveLength(0);
  });
});

describe("a SKU's first movement keeps the count it showed", () => {
  // The finding: Current Qty 10 from the sheet, no ledger rows. The first sale
  // used to compute −1 from that one movement, and the next sync left it there.
  it("a first sale nets off the shown count, and the next sync leaves it at that", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 })];
    const sale = await ledger.applyMovement({ sku: OLD, delta: -1, reason: "order", refType: "order", createdBy: "rakesh@drevifashion.com" });
    expect(sale).toEqual({ ok: true, stock: 9 });
    expect(productRow(OLD)?.current_qty).toBe(9);
    expect(movesFor(OLD)).toEqual([
      expect.objectContaining({ reason: "reset", snapshot_qty: 10, delta: 0, ref_type: "opening_balance", created_by: "rakesh@drevifashion.com" }),
      expect.objectContaining({ reason: "order", delta: -1 }),
    ]);
    // The sync now finds a ledger for it and writes nothing over the 9.
    expect(sheetSyncQty(OLD, 10, true, canonicalBySku(movesFor(OLD) as never))).toBeNull();
    // Ledger and cache agree, and both hold the real count.
    expect(await ledger.canonicalStock(OLD)).toBe(9);
  });

  it("a first receipt adds to it: 10 + 3 = 13", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 })];
    expect((await ledger.applyMovement({ sku: OLD, delta: 3, reason: "receipt" })).stock).toBe(13);
  });

  it("seeds only once: the second movement finds the ledger and adds no balance", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 })];
    await ledger.applyMovement({ sku: OLD, delta: -1, reason: "order" });
    expect((await ledger.applyMovement({ sku: OLD, delta: -2, reason: "order" })).stock).toBe(7);
    expect(movesFor(OLD).filter((m) => m.ref_type === "opening_balance")).toHaveLength(1);
  });

  it("a reset sets the count outright and seeds nothing", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 })];
    expect((await ledger.setStock({ sku: OLD, countedQty: 4, note: "counted", createdBy: "test" })).stock).toBe(4);
    expect(movesFor(OLD)).toEqual([expect.objectContaining({ reason: "reset", snapshot_qty: 4, note: "counted" })]);
  });

  it("a SKU with history, a zero count or no catalog row gets no balance", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 }), product(NEW, { current_qty: 0 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 5 })];
    expect((await ledger.applyMovement({ sku: OLD, delta: -1, reason: "order" })).stock).toBe(4);
    expect((await ledger.applyMovement({ sku: NEW, delta: 2, reason: "receipt" })).stock).toBe(2);
    expect((await ledger.applyMovement({ sku: "DD-NOT-IN-CATALOG-1", delta: 2, reason: "receipt" })).stock).toBe(2);
    expect(db.stock_movements.filter((m) => m.ref_type === "opening_balance")).toHaveLength(0);
  });

  it("a negative shown count carries as a correction", async () => {
    db.wholesale_products = [product(OLD, { current_qty: -2 })];
    expect((await ledger.applyMovement({ sku: OLD, delta: -1, reason: "order" })).stock).toBe(-3);
    expect(movesFor(OLD)[0]).toMatchObject({ reason: "correction", delta: -2, snapshot_qty: null, ref_type: "opening_balance" });
  });

  it("a failed seed refuses the movement rather than posting it on an empty ledger", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 })];
    failInsert = (table, row) => (table === "stock_movements" && row.ref_type === "opening_balance" ? "insert refused" : null);
    expect(await ledger.applyMovement({ sku: OLD, delta: -1, reason: "order" })).toEqual({ ok: false, error: "insert refused" });
    expect(movesFor(OLD)).toHaveLength(0);
    expect(productRow(OLD)?.current_qty).toBe(10);
  });

  it("an unreadable ledger refuses the movement instead of treating the SKU as new", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 4 })];
    failSelect = (table) => (table === "stock_movements" ? "connection reset" : null);
    const r = await ledger.applyMovement({ sku: OLD, delta: -1, reason: "order" });
    expect(r).toEqual({ ok: false, error: "Could not read the stock ledger (connection reset)" });
    expect(movesFor(OLD)).toHaveLength(1);
  });

  it("the master editor lands on the typed number, not the typed number on top of the shown one", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 10 })];
    expect(await master.saveVariant(OLD, { currentQty: 12, wholesalePrice: 2500, stockNote: "found two more" })).toEqual({ ok: true });
    expect(productRow(OLD)?.current_qty).toBe(12);
    expect(movesFor(OLD)).toEqual([
      expect.objectContaining({ reason: "reset", snapshot_qty: 10, ref_type: "opening_balance" }),
      expect.objectContaining({ reason: "manual", delta: 2 }),
    ]);

    db.wholesale_products = [product(NEW, { current_qty: 10 })];
    expect(await master.saveVariant(NEW, { currentQty: 0, wholesalePrice: 2500, stockNote: "sold out at the booth" })).toEqual({ ok: true });
    expect(productRow(NEW)?.current_qty).toBe(0);
    expect(await ledger.canonicalStock(NEW)).toBe(0);
  });
});

describe("updateProductFields refuses a number it cannot read", () => {
  it.each([
    ["wholesale_price", "Rs 1250"],
    ["wholesale_price", "12,5OO"],
    ["min_order_qty", "six"],
    ["restock_days", "soon"],
    ["current_qty", "abc"],
    // Letters and dashes inside a count used to be stripped into a different number.
    ["min_order_qty", "1O"],
    ["restock_days", "5-6"],
    ["current_qty", "1O"],
    ["current_qty", "4-2"],
    ["min_order_qty", "-3"],
    ["current_qty", "2.5"],
  ])("%s = %j is refused, not saved and locked", async (field, raw) => {
    db.wholesale_products = [product(OLD, { wholesale_price: 2500, min_order_qty: 2, restock_days: 10, current_qty: 4 })];
    const before = structuredClone(productRow(OLD));
    const r = await catalog.updateProductFields(OLD, { [field]: raw });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("is not a number");
    expect(productRow(OLD)).toEqual(before);
  });

  it("still reads rupee signs and commas, and empty still means 0 or blank", async () => {
    db.wholesale_products = [product(OLD, { wholesale_price: 2500, min_order_qty: 2, current_qty: 4 })];
    expect((await catalog.updateProductFields(OLD, { wholesale_price: "₹1,250.50" })).ok).toBe(true);
    expect(productRow(OLD)?.wholesale_price).toBe(1250.5);
    expect((await catalog.updateProductFields(OLD, { min_order_qty: "", current_qty: "", wholesale_price: "" })).ok).toBe(true);
    expect(productRow(OLD)).toMatchObject({ min_order_qty: null, current_qty: 0, wholesale_price: 0 });
    expect(productRow(OLD)?.locked_fields).toEqual(expect.arrayContaining(["wholesale_price", "min_order_qty", "current_qty"]));
  });

  it("still reads counts with commas or spaces, and a negative stock count", async () => {
    db.wholesale_products = [product(OLD, { min_order_qty: 2, restock_days: 10, current_qty: 4 })];
    expect((await catalog.updateProductFields(OLD, { min_order_qty: " 12 ", restock_days: "1,000", current_qty: "-3" })).ok).toBe(true);
    expect(productRow(OLD)).toMatchObject({ min_order_qty: 12, restock_days: 1000, current_qty: -3 });
    expect((await catalog.updateProductFields(OLD, { current_qty: "1 200" })).ok).toBe(true);
    expect(productRow(OLD)?.current_qty).toBe(1200);
  });
});

describe("uploadProductPhotoAction", () => {
  it("replaces the front shot and keeps the rest of the gallery", async () => {
    db.wholesale_products = [product(OLD, { image_urls: ["front-old.jpg", "back.jpg", "detail.jpg"] })];
    const fd = new FormData();
    fd.set("image", new File([new Uint8Array([1, 2, 3])], "front.jpg", { type: "image/jpeg" }));
    const r = await catalog.uploadProductPhotoAction(OLD, fd);
    expect(r.ok).toBe(true);
    const urls = productRow(OLD)?.image_urls as string[];
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(r.url);
    expect(urls[0]).toMatch(/^https:\/\/cdn\.example\.test\/product-photos\/.+\?v=/);
    expect(urls.slice(1)).toEqual(["back.jpg", "detail.jpg"]);
    expect(productRow(OLD)?.locked_fields).toContain("image_urls");
  });

  it("gives a product with no photos just the new one", async () => {
    db.wholesale_products = [product(OLD, { image_urls: null })];
    const fd = new FormData();
    fd.set("image", new File([new Uint8Array([1])], "front.png", { type: "image/png" }));
    const r = await catalog.uploadProductPhotoAction(OLD, fd);
    expect(productRow(OLD)?.image_urls).toEqual([r.url]);
  });
});

describe("voidRetailBill", () => {
  const bill = (items: Row[]): Row => ({ id: "rb-1", bill_number: "RB-20261110-001", items, voided_at: null });

  it("returns stock for catalog lines only; custom lines never took any", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 3 }), product(NEW, { current_qty: 0 })];
    db.stock_movements = [move(OLD, { reason: "reset", snapshot_qty: 3 })];
    db.retail_bills = [bill([
      { sku: OLD, qty: 2, unit_price: 4000 },
      { sku: "CUSTOM", qty: 1, unit_price: 1500, custom: true, title: "Alteration" },
      // A custom line whose "Also add to catalog" created a real SKU at 0.
      { sku: NEW, qty: 1, unit_price: 900, custom: true, title: "Dupatta" },
    ])];
    const r = await retail.voidRetailBill("rb-1");
    expect(r).toEqual({ ok: true });
    expect(db.stock_movements.map((m) => m.sku)).toEqual([OLD, OLD]);
    expect(productRow(OLD)?.current_qty).toBe(5);
    expect(productRow(NEW)?.current_qty).toBe(0);
    expect(db.retail_bills[0].voided_at).toBeTruthy();
  });

  it("hands back a failed return as a warning on an ok result", async () => {
    db.wholesale_products = [product(OLD, { current_qty: 3 })];
    db.retail_bills = [bill([{ sku: OLD, qty: 1, unit_price: 4000 }])];
    failInsert = (table) => (table === "stock_movements" ? "insert refused" : null);
    const r = await retail.voidRetailBill("rb-1");
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.warning).toContain(`stock did NOT return for ${OLD}`);
  });
});

describe("submitExhibitionOrder: Also add to catalog", () => {
  const CUSTOM_SKU = "DD-LEH-FLR-900-M-GLD";
  const SOLD_OUT = "DD-LEH-FLR-020-M-BLU";
  const custom = { sku: "", qty: 1, unitPrice: 3000, customTitle: "Gold lehenga", syncToCatalog: true, catalogSku: CUSTOM_SKU };

  beforeEach(() => {
    db.exhibition_sessions = [{ id: "s1", session_type: "exhibition", event_name: "Expo", orders_count: 0, ended_at: null }];
    db.wholesale_products = [product(SOLD_OUT, { current_qty: 0, restockable: false })];
  });

  it("creates nothing when a sold-out line bounces the submit, so the retry goes through", async () => {
    const first = await exhibition.submitExhibitionOrder({
      sessionId: "s1", eventName: "Expo", buyerId: "b1",
      items: [custom, { sku: SOLD_OUT, qty: 1 }],
    });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("No longer orderable");
    expect(productRow(CUSTOM_SKU)).toBeUndefined();

    const retry = await exhibition.submitExhibitionOrder({ sessionId: "s1", eventName: "Expo", buyerId: "b1", items: [custom] });
    expect(retry.ok).toBe(true);
    expect(productRow(CUSTOM_SKU)).toMatchObject({ title: "Gold lehenga", wholesale_price: 3000, wholesale_visible: false });
    expect(db.orders).toHaveLength(1);
  });

  it("creates nothing when the advance is refused", async () => {
    const r = await exhibition.submitExhibitionOrder({ sessionId: "s1", eventName: "Expo", buyerId: "b1", items: [custom], advanceAmount: 99999 });
    expect(r).toMatchObject({ ok: false, error: "Advance cannot exceed the order total." });
    expect(productRow(CUSTOM_SKU)).toBeUndefined();
  });

  it("still refuses the order when the catalog SKU is taken", async () => {
    db.wholesale_products.push(product(CUSTOM_SKU));
    const r = await exhibition.submitExhibitionOrder({ sessionId: "s1", eventName: "Expo", buyerId: "b1", items: [custom] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already exists in the catalog");
    expect(db.orders).toHaveLength(0);
  });

  it("files a drained back-dated order under its bill date", async () => {
    const r = await exhibition.submitExhibitionOrder({
      sessionId: "s1", eventName: "Expo", buyerId: "b1", fromQueue: true, billDate: "2026-11-01",
      items: [{ sku: "", qty: 1, unitPrice: 1000, customTitle: "Sample" }],
    });
    expect(r.ok).toBe(true);
    expect(db.orders[0].submitted_at.startsWith("2026-11-01")).toBe(true);
  });
});

describe("upsertLov refuses codes that cannot sit inside a SKU", () => {
  it("refuses a bad category, an unscoped sub-category and a hyphenated colour without writing", async () => {
    for (const [list, code] of [["category", "BRIDAL"], ["sub_category", "FLR"], ["color", "RS-GLD"], ["size", "2-3Y"]] as const) {
      const r = await lovs.upsertLov({ list, code });
      expect(r.ok).toBe(false);
    }
    expect(db.lovs).toHaveLength(0);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it("accepts good codes, lower case included, and leaves fabric free-form", async () => {
    expect((await lovs.upsertLov({ list: "sub_category", code: "leh-a1", label: "A-line" })).ok).toBe(true);
    expect((await lovs.upsertLov({ list: "fabric", code: "Raw silk / organza" })).ok).toBe(true);
    expect(db.lovs.map((l) => l.code)).toEqual(["LEH-A1", "RAW SILK / ORGANZA"]);
  });
});

describe("global scan resolve", () => {
  const get = async (sku: string) => (await scan.GET(new Request(`https://portal.example.test/api/scan/resolve?sku=${sku}`))).json();
  const keys = (j: { actions: { key: string }[] }) => j.actions.map((a) => a.key);

  it("treats a size minted in the registry but not received yet as known, without a dead-end edit", async () => {
    db.sku_registry = [{ variant_sku: OLD }];
    const j = await get(OLD.toLowerCase());
    expect(j.known).toBe(true);
    expect(keys(j)).not.toContain("create_sku");
    expect(keys(j)).not.toContain("edit_master");
    expect(keys(j)).toContain("log_receipt");
  });

  it("offers Edit product master where Manage Catalog has the row", async () => {
    db.wholesale_products = [product(OLD)];
    expect(keys(await get(OLD))).toContain("edit_master");
  });

  it("knows a SKU with only vendor info, but offers no Edit product master for it", async () => {
    db.product_vendor_info = [{ sku: OLD, vendor_name: "Surat Silks", retail_price: 4200, locked_fields: [] }];
    const j = await get(OLD);
    expect(j.known).toBe(true);
    expect(keys(j)).not.toContain("edit_master");
    expect(keys(j)).toContain("log_receipt");
  });

  it("still offers Create SKU for a code nobody knows", async () => {
    const j = await get("DD-LEH-FLR-404-M-RED");
    expect(j.known).toBe(false);
    expect(keys(j)).toEqual(["create_sku"]);
  });
});

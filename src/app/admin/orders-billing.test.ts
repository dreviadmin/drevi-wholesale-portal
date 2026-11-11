/* eslint-disable @typescript-eslint/no-explicit-any -- the fake query builder is untyped on purpose */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrderItem } from "@/lib/types";

// The order and agent actions talk to Supabase, Next's cache and the audit
// log. Supabase is replaced by a small in-memory database that honours the
// filters each query sets — so a lines_rev compare-and-set really does miss
// when another writer got there first — and `beforeUpdate` lets a test play
// that other writer at the exact moment between a read and its write.

type Row = Record<string, any>;
let db: Record<string, Row[]> = {};
let writes: { table: string; op: "update" | "insert" | "delete"; payload?: unknown; filters: string[] }[] = [];
let beforeUpdate: ((table: string) => void) | null = null;
let beforeSelect: ((table: string) => void) | null = null;
let nextId = 0;

function fakeAdmin() {
  return {
    from(table: string) {
      let op: "select" | "update" | "insert" | "delete" = "select";
      let payload: any;
      let returning = false;
      let head = false;
      let count = false;
      let one: "maybe" | "single" | null = null;
      let sort: { key: string; asc: boolean } | null = null;
      let lim: number | null = null;
      const tests: ((r: Row) => boolean)[] = [];
      const filters: string[] = [];
      const b: any = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          if (op !== "select") returning = true;
          count = !!opts?.count;
          head = !!opts?.head;
          return b;
        },
        update(p: Row) { op = "update"; payload = p; return b; },
        insert(p: Row | Row[]) { op = "insert"; payload = p; return b; },
        delete() { op = "delete"; return b; },
        eq(k: string, v: unknown) { tests.push((r) => r[k] === v); filters.push(`${k}=${String(v)}`); return b; },
        neq(k: string, v: unknown) { tests.push((r) => r[k] !== v); filters.push(`${k}!=${String(v)}`); return b; },
        is(k: string, v: unknown) { tests.push((r) => (r[k] ?? null) === v); filters.push(`${k} is ${String(v)}`); return b; },
        in(k: string, vs: unknown[]) { tests.push((r) => vs.includes(r[k])); filters.push(`${k} in`); return b; },
        order(k: string, o?: { ascending?: boolean }) { sort = { key: k, asc: o?.ascending !== false }; return b; },
        limit(n: number) { lim = n; return b; },
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
      function run() {
        if (op === "select") {
          beforeSelect?.(table);
          let list = match();
          if (sort) {
            const { key, asc } = sort;
            list = [...list].sort((x, y) => (x[key] < y[key] ? -1 : x[key] > y[key] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (lim != null) list = list.slice(0, lim);
          if (count && head) return { data: null, count: list.length, error: null };
          return shape(list);
        }
        if (op === "update") {
          beforeUpdate?.(table);
          const hit = match();
          for (const r of hit) Object.assign(r, structuredClone(payload));
          writes.push({ table, op, payload: structuredClone(payload), filters });
          return returning ? shape(hit) : { data: null, error: null };
        }
        if (op === "insert") {
          const list = (Array.isArray(payload) ? payload : [payload]).map((p: Row): Row => ({ id: `${table}-${++nextId}`, ...structuredClone(p) }));
          if (table === "order_bills" && list.some((n) => rows().some((r) => r.order_id === n.order_id && r.seq === n.seq))) {
            return { data: null, error: { message: "duplicate key", code: "23505" } };
          }
          rows().push(...list);
          writes.push({ table, op, payload: structuredClone(payload), filters });
          return returning ? shape(list) : { data: null, error: null };
        }
        const hit = match();
        db[table] = rows().filter((r) => !hit.includes(r));
        writes.push({ table, op, filters });
        return { data: null, error: null };
      }
      return b;
    },
  };
}

const STAFF = { id: "staff-1", email: "rakesh@drevifashion.com", name: "Rakesh", role: "super_admin" as const };
const writeAuditEvent = vi.fn(async (e: Record<string, unknown>) => { void e; });
const finalizeOrder = vi.fn(async (id: string, o?: unknown) => { void id; void o; return { pdfUrl: "https://example.test/o.pdf" }; });
const renderAndStoreBillPdf = vi.fn(async (...a: unknown[]) => { void a; return { url: "https://example.test/b.pdf" }; });

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/staff", () => ({
  requireAdmin: async () => STAFF,
  requireStaff: async () => STAFF,
}));
vi.mock("@/lib/audit", () => ({ writeAuditEvent: (e: Record<string, unknown>) => writeAuditEvent(e) }));
vi.mock("@/lib/catalog-row", () => ({ ensureCatalogRow: async () => ({ ok: true }) }));
vi.mock("@/lib/order-finalize", () => ({ finalizeOrder: (id: string, o?: unknown) => finalizeOrder(id, o) }));
vi.mock("@/lib/stock-ledger", () => ({ postOrderMovements: async () => ({ ok: true }), applyMovement: async () => ({ ok: true }) }));
vi.mock("@/lib/stock", () => ({ getStockState: async () => "ready" }));
vi.mock("@/lib/design-image-store", () => ({ storeAuxPhoto: async () => ({ ok: false }) }));
vi.mock("@/lib/bill-pdf", () => ({ renderAndStoreBillPdf: (...a: unknown[]) => renderAndStoreBillPdf(...a) }));
vi.mock("@/lib/buyer-snapshot", () => ({
  captureBuyerSnapshot: async () => ({}),
  resolveDocumentParty: async () => ({}),
  snapshotSourceForDate: () => "live",
}));
vi.mock("@/lib/agent-ledger", () => ({
  loadAgentAccount: async () => ({ totals: { payable: 100000 }, orders: [], payments: [] }),
  accrueCommission: async () => ({ accrued: false }),
}));
vi.mock("@/lib/agent-core", () => ({ payoutCheck: () => ({ ok: true }) }));
// Vitest here does not resolve the @/ alias, so the real modules under test
// are loaded by relative path.
vi.mock("@/lib/order-lines-core", async () => await import("../../lib/order-lines-core"));
vi.mock("@/lib/order-catalog-sync", async () => await import("../../lib/order-catalog-sync"));
vi.mock("@/lib/format", async () => await import("../../lib/format"));

const orders = await import("./orders/actions");
const agents = await import("./agents/actions");
const { refreshOrderFromCatalog } = await import("../../lib/order-catalog-sync");

const line = (over: Partial<OrderItem> = {}): OrderItem => ({
  sku: "DD-LEH-FLR-001-M-RED",
  title: "Floral lehenga",
  unit_price: 2000,
  qty: 5,
  stock_state: "ready",
  restock_days: null,
  ...over,
});

function seedOrder(over: Row = {}): Row {
  const o = {
    id: "o1",
    order_number: "DRV-0001",
    buyer_id: "b1",
    status: "confirmed",
    submitted_at: "2026-10-01T06:30:00.000Z",
    items: [line()],
    lines_rev: 4,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    tax_mode: "none",
    tax_rate: null,
    tax_amount: 0,
    advance_amount: 0,
    credit_applied: 0,
    payment_method: null,
    payment_notes: null,
    total_amount: 10000,
    ...over,
  };
  db.orders = [o];
  return o;
}

const bill = (over: Row = {}): Row => ({
  id: "bill-1",
  order_id: "o1",
  bill_number: "DRV-0001-B1",
  seq: 1,
  bill_date: "2026-10-02",
  items: [line()],
  discount_amount: 0,
  advance_applied: 0,
  total: 10000,
  cancelled_at: null,
  cancel_reason: null,
  ...over,
});

const orderRow = () => db.orders[0];
const billRow = (id: string) => db.order_bills.find((b) => b.id === id)!;

beforeEach(() => {
  db = { orders: [], order_bills: [], credit_notes: [], wholesale_products: [], agent_payments: [] };
  writes = [];
  beforeUpdate = null;
  beforeSelect = null;
  nextId = 0;
  writeAuditEvent.mockClear();
  finalizeOrder.mockClear();
  renderAndStoreBillPdf.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Modify Order on a billed order", () => {
  const storedTerms = { discount_type: "absolute", discount_value: 2000, tax_mode: "exclusive", tax_rate: 12 };
  const editorTerms = { discountType: "absolute" as const, discountValue: 2000, taxMode: "exclusive" as const, taxRate: 12, advanceAmount: 0, paymentMethod: null, paymentNotes: null };
  const keep = (index: number, qty: number) => ({ kind: "keep" as const, index, qty, unitPrice: 2000, actualQty: null });

  function billedOrder(billCancelled = false) {
    seedOrder({
      ...storedTerms,
      items: [
        line({ line_state: "confirmed", billed_in: billCancelled ? undefined : "bill-1" }),
        line({ sku: "DD-KUR-PLN-002-L-BLU", title: "Plain kurta", qty: 3, line_state: "pending" }),
      ],
    });
    db.order_bills = [bill({ cancelled_at: billCancelled ? "2026-10-03T10:00:00Z" : null })];
  }

  it("saves a pending line's new qty when the editor re-sends the stored terms", async () => {
    billedOrder();
    const r = await orders.updateOrderItems("o1", [keep(0, 5), keep(1, 4)], editorTerms);
    expect(r).toMatchObject({ ok: true });
    expect(orderRow().items[1].qty).toBe(4);
    expect(orderRow().items[0].billed_in).toBe("bill-1");
    expect(orderRow().lines_rev).toBe(5);
  });

  it("still refuses moving the discount or tax while a live bill prices off them", async () => {
    billedOrder();
    for (const terms of [
      { ...editorTerms, discountValue: 2500 },
      { ...editorTerms, discountType: null, discountValue: null },
      { ...editorTerms, taxRate: 18 },
      { ...editorTerms, taxMode: "none" as const, taxRate: null },
    ]) {
      const r = await orders.updateOrderItems("o1", [keep(0, 5), keep(1, 3)], terms);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("This order has a bill");
    }
    expect(writes.some((w) => w.table === "orders")).toBe(false);
  });

  it("refuses a move while an issued credit note was priced off the terms", async () => {
    seedOrder({ ...storedTerms, items: [line({ line_state: "confirmed" })] });
    db.credit_notes = [{ id: "cn-1", order_id: "o1", status: "issued" }];
    const r = await orders.updateOrderItems("o1", [keep(0, 5)], { ...editorTerms, discountValue: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("credit note");
  });

  it("lets the terms move once the only bill is cancelled", async () => {
    billedOrder(true);
    const r = await orders.updateOrderItems("o1", [keep(0, 5), keep(1, 3)], { ...editorTerms, discountValue: 2500 });
    expect(r.ok).toBe(true);
    expect(orderRow().discount_value).toBe(2500);
  });
});

describe("generateOrderBill: a cancelled bill gives its discount and advance back", () => {
  const terms = { discount_type: "absolute", discount_value: 2000, advance_amount: 5000 };

  it("a bill raised after B1 was cancelled gets the whole discount and advance, and is numbered B2", async () => {
    seedOrder({ ...terms, items: [line({ qty: 10, line_state: "confirmed" })] });
    db.order_bills = [bill({ discount_amount: 2000, advance_applied: 5000, total: 18000, cancelled_at: "2026-10-03T10:00:00Z" })];
    const r = await orders.generateOrderBill("o1");
    expect(r).toMatchObject({ ok: true, billNumber: "DRV-0001-B2" });
    const b2 = db.order_bills.find((b) => b.bill_number === "DRV-0001-B2")!;
    expect(b2).toMatchObject({ seq: 2, discount_amount: 2000, advance_applied: 5000, total: 18000 });
    expect(orderRow().items[0].billed_in).toBe(b2.id);
  });

  it("a live B1 still uses up what it took", async () => {
    seedOrder({
      ...terms,
      items: [line({ qty: 10, line_state: "confirmed", billed_in: "bill-1" }), line({ sku: "DD-KUR-PLN-002-L-BLU", qty: 5, line_state: "confirmed" })],
    });
    db.order_bills = [bill({ discount_amount: 2000, advance_applied: 5000, total: 18000 })];
    const r = await orders.generateOrderBill("o1");
    expect(r.ok).toBe(true);
    const b2 = db.order_bills.find((b) => b.bill_number === "DRV-0001-B2")!;
    expect(b2).toMatchObject({ discount_amount: 0, advance_applied: 0, total: 10000 });
  });

  it("points at Release lines when lines are stuck on a cancelled bill", async () => {
    seedOrder({ items: [line({ line_state: "confirmed", billed_in: "bill-1" })] });
    db.order_bills = [bill({ cancelled_at: "2026-10-03T10:00:00Z" })];
    const r = await orders.generateOrderBill("o1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("use Release lines on that bill");
  });
});

describe("cancelBill and Release lines", () => {
  function billedTwice() {
    seedOrder({
      items: [
        line({ line_state: "confirmed", billed_in: "bill-1" }),
        line({ sku: "DD-KUR-PLN-002-L-BLU", line_state: "confirmed", billed_in: "bill-1" }),
        line({ sku: "DD-SAR-SLK-003-F-GRN", line_state: "hold", hold_note: "back in a week" }),
      ],
    });
    db.order_bills = [bill()];
  }

  it("cancels the bill and sends its lines back to the order", async () => {
    billedTwice();
    const r = await orders.cancelBill("bill-1", "Wrong rate on the invoice");
    expect(r).toEqual({ ok: true, billNumber: "DRV-0001-B1", linesFreed: 2 });
    expect(billRow("bill-1")).toMatchObject({ cancelled_by: STAFF.email, cancel_reason: "Wrong rate on the invoice" });
    expect(billRow("bill-1").cancelled_at).toBeTruthy();
    expect(orderRow().items.every((it: OrderItem) => !it.billed_in)).toBe(true);
    expect(orderRow().lines_rev).toBe(5);
  });

  it("retries the release when another line write lands first, keeping that write", async () => {
    billedTwice();
    let raced = false;
    beforeUpdate = (table) => {
      if (table !== "orders" || raced) return;
      raced = true;
      orderRow().items[2] = { ...orderRow().items[2], hold_note: "back on Monday" };
      orderRow().lines_rev += 1;
    };
    const r = await orders.cancelBill("bill-1", "Wrong rate on the invoice");
    expect(r).toMatchObject({ ok: true, linesFreed: 2 });
    expect(orderRow().items.every((it: OrderItem) => !it.billed_in)).toBe(true);
    expect(orderRow().items[2].hold_note).toBe("back on Monday");
    expect(orderRow().lines_rev).toBe(6);
  });

  it("a release that keeps losing says so, and Release lines finishes the job later", async () => {
    billedTwice();
    beforeUpdate = (table) => {
      if (table === "orders") orderRow().lines_rev += 1;
    };
    const first = await orders.cancelBill("bill-1", "Wrong rate on the invoice");
    expect(first.ok).toBe(false);
    expect(first.error).toContain("the bill IS cancelled, but its lines were not released");
    expect(billRow("bill-1").cancelled_at).toBeTruthy();
    expect(orderRow().items.filter((it: OrderItem) => it.billed_in === "bill-1")).toHaveLength(2);

    beforeUpdate = null;
    const cancelledAt = billRow("bill-1").cancelled_at;
    const again = await orders.cancelBill("bill-1", "Releasing the stuck lines");
    expect(again).toEqual({ ok: true, billNumber: "DRV-0001-B1", linesFreed: 2 });
    expect(orderRow().items.every((it: OrderItem) => !it.billed_in)).toBe(true);
    // The bill keeps the cancellation it had; only the lines moved.
    expect(billRow("bill-1").cancelled_at).toBe(cancelledAt);
    expect(billRow("bill-1").cancel_reason).toBe("Wrong rate on the invoice");
    expect(writeAuditEvent.mock.calls.at(-1)?.[0].notes).toContain("already cancelled");
  });

  it("a cancelled bill with nothing left to release is still just already cancelled", async () => {
    seedOrder({ items: [line({ line_state: "confirmed" })] });
    db.order_bills = [bill({ cancelled_at: "2026-10-03T10:00:00Z" })];
    const r = await orders.cancelBill("bill-1", "again");
    expect(r).toEqual({ ok: false, error: "DRV-0001-B1 is already cancelled." });
    expect(writes).toHaveLength(0);
  });

  it("still refuses while an issued credit note reverses the bill", async () => {
    billedTwice();
    db.credit_notes = [{ id: "cn-1", order_bill_id: "bill-1", status: "issued" }];
    const r = await orders.cancelBill("bill-1", "Wrong rate");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("void it before cancelling");
    expect(billRow("bill-1").cancelled_at).toBeNull();
  });
});

describe("setOrderLineHsn writes through the line guard", () => {
  it("an HSN saved while a bill marks another line keeps that bill's mark", async () => {
    seedOrder({
      items: [line({ line_state: "confirmed" }), line({ sku: "DD-KUR-PLN-002-L-BLU", line_state: "confirmed" })],
    });
    let raced = false;
    beforeUpdate = (table) => {
      if (table !== "orders" || raced) return;
      raced = true;
      orderRow().items[1] = { ...orderRow().items[1], billed_in: "bill-9" };
      orderRow().lines_rev += 1;
    };
    const r = await orders.setOrderLineHsn("o1", 0, "6204");
    expect(r).toEqual({ ok: true });
    expect(orderRow().items[0].hsn).toBe("6204");
    expect(orderRow().items[1].billed_in).toBe("bill-9");
    // The bill's own bump (4 → 5) stands; the HSN retry adds none.
    expect(orderRow().lines_rev).toBe(5);
    const orderWrites = writes.filter((w) => w.table === "orders");
    expect(orderWrites.every((w) => w.filters.some((f) => f.startsWith("lines_rev=")))).toBe(true);
  });

  it("an HSN edit keeps lines_rev, so an agent's frozen commission is not marked revised", async () => {
    seedOrder({ items: [line({ line_state: "confirmed" })] });
    const r = await orders.setOrderLineHsn("o1", 0, "6204");
    expect(r).toEqual({ ok: true });
    expect(orderRow().items[0].hsn).toBe("6204");
    expect(orderRow().lines_rev).toBe(4);
    // Still guarded: the write only lands on the revision it read.
    const orderWrites = writes.filter((w) => w.table === "orders");
    expect(orderWrites).toHaveLength(1);
    expect(orderWrites[0].filters).toContain("lines_rev=4");
  });

  it("refuses when another session moved a different line into that slot", async () => {
    seedOrder({ items: [line(), line({ sku: "DD-KUR-PLN-002-L-BLU" })] });
    // Line 0 is removed after the action read the order but before its write.
    let orderReads = 0;
    beforeSelect = (table) => {
      if (table === "orders" && ++orderReads === 2) {
        orderRow().items = [line({ sku: "DD-KUR-PLN-002-L-BLU" })];
        orderRow().lines_rev += 1;
      }
    };
    const r = await orders.setOrderLineHsn("o1", 0, "6204");
    expect(r).toEqual({ ok: false, error: "The order changed — reload the page." });
    expect(orderRow().items[0].hsn).toBeUndefined();
    expect(writes.some((w) => w.table === "orders")).toBe(false);
  });
});

describe("bill and order date corrections ignore cancelled bills", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T06:00:00Z"));
  });

  it("a cancelled bill cannot be re-dated", async () => {
    seedOrder();
    db.order_bills = [bill({ cancelled_at: "2026-10-03T10:00:00Z" })];
    const r = await orders.setBillDate("bill-1", "2026-10-05", "typed wrong");
    expect(r).toEqual({ ok: false, error: "This bill is cancelled — its date stands." });
    expect(writes).toHaveLength(0);
  });

  it("the order date may move past a cancelled bill, but not past the first live one", async () => {
    seedOrder();
    db.order_bills = [
      bill({ id: "bill-1", bill_date: "2026-10-02", cancelled_at: "2026-10-03T10:00:00Z" }),
      bill({ id: "bill-2", seq: 2, bill_number: "DRV-0001-B2", bill_date: "2026-10-08" }),
    ];
    const ok = await orders.setOrderDate("o1", "2026-10-05", "entered a day early");
    expect(ok).toMatchObject({ ok: true });
    expect(orderRow().submitted_at.slice(0, 10)).toBe("2026-10-05");

    const late = await orders.setOrderDate("o1", "2026-10-09", "entered late");
    expect(late.ok).toBe(false);
    expect(late.error).toContain("DRV-0001-B2 is dated 2026-10-08");
  });
});

describe("refreshOrderFromCatalog only lands on the items it read", () => {
  function catalogChanged() {
    seedOrder({
      lines_rev: 7,
      items: [line({ title: "Old title" }), line({ sku: "DD-KUR-PLN-002-L-BLU", title: "Plain kurta", line_state: "confirmed" })],
    });
    db.wholesale_products = [{ sku: "DD-LEH-FLR-001-M-RED", title: "Floral lehenga", image_urls: ["https://example.test/a.jpg"], hsn: "6204" }];
  }

  it("refreshes the descriptive fields without counting as a line revision", async () => {
    catalogChanged();
    const r = await refreshOrderFromCatalog(fakeAdmin() as never, "o1");
    expect(r).toMatchObject({ ok: true, changed: true, touchedSkus: ["DD-LEH-FLR-001-M-RED"] });
    expect(orderRow().items[0]).toMatchObject({ title: "Floral lehenga", hsn: "6204", image_url: "https://example.test/a.jpg" });
    expect(orderRow().lines_rev).toBe(7);
  });

  it("re-reads and keeps a bill's mark that landed mid-refresh", async () => {
    catalogChanged();
    let raced = false;
    beforeUpdate = (table) => {
      if (table !== "orders" || raced) return;
      raced = true;
      orderRow().items[1] = { ...orderRow().items[1], billed_in: "bill-3" };
      orderRow().lines_rev += 1;
    };
    const r = await refreshOrderFromCatalog(fakeAdmin() as never, "o1");
    expect(r.ok).toBe(true);
    expect(orderRow().items[1].billed_in).toBe("bill-3");
    expect(orderRow().items[0].title).toBe("Floral lehenga");
    expect(orderRow().lines_rev).toBe(8);
  });

  it("gives up after three lost races without overwriting anything", async () => {
    catalogChanged();
    beforeUpdate = (table) => {
      if (table !== "orders") return;
      orderRow().items[1] = { ...orderRow().items[1], billed_in: "bill-3" };
      orderRow().lines_rev += 1;
    };
    const r = await refreshOrderFromCatalog(fakeAdmin() as never, "o1");
    expect(r).toEqual({ ok: false, error: "The order kept changing during the refresh — try again in a moment." });
    expect(orderRow().items[0].title).toBe("Old title");
    expect(orderRow().items[1].billed_in).toBe("bill-3");
  });
});

describe("recordAgentPayment dates the payout by the IST day", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 01:30 IST on 5 Oct, still 4 Oct in UTC.
    vi.setSystemTime(new Date("2026-10-04T20:00:00Z"));
  });
  const pay = (paidOn?: string) => agents.recordAgentPayment({ agentId: "ag1", amount: 1500, paidOn, clientRef: `ref-${paidOn ?? "none"}` });

  it("defaults to today in IST", async () => {
    expect(await pay()).toEqual({ ok: true });
    expect(db.agent_payments[0].paid_on).toBe("2026-10-05");
  });

  it("keeps a real past date", async () => {
    expect(await pay("2026-10-01")).toEqual({ ok: true });
    expect(db.agent_payments[0].paid_on).toBe("2026-10-01");
  });

  it("refuses a future or impossible date", async () => {
    for (const d of ["2026-10-06", "2026-02-30", "5/10/2026"]) {
      const r = await pay(d);
      expect(r).toEqual({ ok: false, error: "Payment date must be a valid date, today or earlier." });
    }
    expect(db.agent_payments).toHaveLength(0);
  });
});

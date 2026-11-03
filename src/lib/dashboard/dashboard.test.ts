import { describe, expect, it } from "vitest";
import { addDays, fmtDay, inBounds, istDay, rangeBounds, weekStart } from "./dates";
import {
  addFilter, availableViews, defaultSort, nextView, NONE, parseDashState, removeFilter, resolveView, serializeDashState, withFilter, type DashState, type Filter,
} from "./state";
import { designOf, lineKey, normName, orderBalance, orderOverpaid, partyName, returnedPieces, type DashBuyer, type DashLine, type DashOrder } from "./lines";
import { buildVendorIndex } from "./vendor";
import {
  buildContext, chaseByVendor, customerFacts, flatten, pendingRows, rollCategories, rollCustomers, rollEvents, rollOrders, rollProducts,
  rollReorder, rollVendors, scopeOf, stockFor, summarise, trendPoints, unsoldDesigns, type DashProduct, type VendorInfo,
} from "./rollup";
import { trendBuckets } from "./trend";
import { buildFindIndex, searchFind } from "./find";
import { toCsv } from "./csv";

const line = (over: Partial<DashLine> = {}): DashLine => ({ sku: "DD-SUT-PLZ-008-M-CRM", title: "Rose Suit", qty: 1, unit_price: 1000, ...over });
const order = (over: Partial<DashOrder> = {}): DashOrder => ({
  id: "o1", order_number: "DX-1", status: "confirmed", source: "exhibition", exhibition_event: null,
  total_amount: 1000, advance_amount: 0, credit_applied: 0, submitted_at: "2026-09-10T06:00:00Z", buyer_id: "b1", items: [line()], ...over,
});
const product = (over: Partial<DashProduct> = {}): DashProduct => ({
  sku: "DD-SUT-PLZ-008-M-CRM", title: "Rose Suit", image_urls: null, current_qty: 5, wholesale_price: 1000, category: "Suit Set",
  restockable: true, wholesale_visible: true, ...over,
});
const info = (sku: string, name: string | null, extra: Partial<VendorInfo> = {}): VendorInfo & { vendor_id: string | null } => ({
  sku, vendor_name: name, vendor_id: null, vendor_sku: null, last_cost: 0, last_receipt_date: null, ...extra,
});
const ctxOf = (products: DashProduct[], vendorBySku: Record<string, { key: string; name: string; vendorSku: string | null }> = {}) =>
  buildContext({ products, info: [], vendorBySku, categoryBySku: {}, supplyByDesign: {}, grBySku: {} });

describe("IST days", () => {
  it("turns over at IST midnight, not UTC", () => {
    expect(istDay("2026-10-31T18:29:00Z")).toBe("2026-10-31");
    expect(istDay("2026-10-31T18:31:00Z")).toBe("2026-11-01");
  });
  it("counts today in the 7 day window and starts at a whole day", () => {
    const now = Date.parse("2026-11-01T06:00:00Z");
    expect(rangeBounds("7d", "", "", now)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(rangeBounds("mtd", "", "", now)).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(rangeBounds("all", "", "", now)).toEqual({ from: null, to: null });
  });
  it("matches nothing while Custom has no dates", () => {
    const bounds = rangeBounds("custom", "", "", 0);
    expect(bounds).toBeNull();
    expect(inBounds("2026-01-01", bounds)).toBe(false);
  });
  it("formats and steps without local time", () => {
    expect(fmtDay("2026-09-05")).toBe("5 Sep");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(weekStart("2026-11-01")).toBe("2026-10-26"); // a Sunday belongs to the Monday before
  });
});

describe("url state", () => {
  const params = (qs: string) => new URLSearchParams(qs);
  const state = (over: Partial<DashState> = {}): DashState => ({
    view: "products", filters: [], range: "all", start: "", end: "", source: null, sort: null, group: "customer", stock: null, ...over,
  });

  it("round-trips, colons in values included", () => {
    const s = state({
      view: "orders", filters: [{ dim: "vendor", value: "name:shree: fabrics" }, { dim: "customer", value: "b1" }],
      range: "custom", start: "2026-09-01", end: "2026-09-30", source: "exhibition", sort: { key: "date", dir: "asc" },
    });
    expect(parseDashState(params(serializeDashState(s)), "products")).toEqual(s);
  });
  it("keeps one filter per kind, the last one winning", () => {
    const s = parseDashState(params("f=vendor:a&f=vendor:b"), "products");
    expect(s.filters).toEqual([{ dim: "vendor", value: "b" }]);
  });
  it("accepts only real dates in a sane range", () => {
    expect(parseDashState(params("range=custom&end=9999-12-31"), "products").end).toBe("");
    expect(parseDashState(params("range=custom&start=2026-13-45"), "products").start).toBe("");
    expect(parseDashState(params("range=custom&start=2026-02-30"), "products").start).toBe("");
    expect(parseDashState(params("range=custom&start=2026-02-28"), "products").start).toBe("2026-02-28");
  });
  it("drops what it does not understand", () => {
    const s = parseDashState(params("view=nope&f=junk:x&f=vendor&range=forever&source=moon&start=yesterday&sort=nope.up&group=x&stock=x"), "products");
    expect(s).toEqual(state());
  });
  it("uses the route's own default view only when the URL names none", () => {
    expect(parseDashState(params(""), "reorder").view).toBe("reorder");
    expect(parseDashState(params("view=products"), "reorder").view).toBe("products");
  });
  it("falls back from a view these filters hide", () => {
    expect(parseDashState(params("view=products&f=design:A|B"), "products").view).toBe("customers");
    expect(resolveView("reorder", [{ dim: "customer", value: "b" }])).toBe("products");
  });
  it("forgets a sort on a column the view no longer has", () => {
    expect(parseDashState(params("view=customers&sort=balance.desc"), "products").sort).toEqual({ key: "balance", dir: "desc" });
    expect(parseDashState(params("view=customers&sort=balance.desc&f=vendor:a"), "products").sort).toBeNull();
  });
  it("leaves pending-only and reorder-only settings out of other views", () => {
    expect(serializeDashState(state({ view: "products", group: "vendor", stock: "low" }))).toBe("view=products");
    expect(serializeDashState(state({ view: "pending", group: "vendor" }))).toBe("view=pending&group=vendor");
  });
});

describe("view rules", () => {
  const f = (dim: Filter["dim"], value = "x"): Filter => ({ dim, value });

  it("hides the view for whatever is already filtered", () => {
    expect(availableViews([f("vendor")])).not.toContain("vendors");
    expect(availableViews([f("design")])).toEqual(["customers", "orders", "pending", "reorder", "events"]);
    expect(availableViews([f("customer")])).toEqual(["products", "vendors", "orders", "pending", "category", "events"]);
    expect(availableViews([f("event")])).not.toContain("reorder");
  });
  it("always leaves a view for any stack", () => {
    const all = ["vendor", "design", "customer", "category", "event"] as const;
    for (const a of all) for (const b of all) {
      const views = availableViews(addFilter([f(a)], f(b)));
      expect(views.length).toBeGreaterThan(0);
      expect(views).toContain("orders");
    }
  });
  it("opens the useful next view", () => {
    expect(nextView("vendors", "vendor", [f("vendor")])).toBe("products");
    expect(nextView("products", "design", [f("design")])).toBe("customers");
    expect(nextView("customers", "customer", [f("customer")])).toBe("orders");
    expect(nextView("customers", "customer", [f("vendor"), f("customer")])).toBe("products");
  });
  it("stays on a task view while it can", () => {
    expect(nextView("reorder", "vendor", [f("vendor")])).toBe("reorder");
    expect(nextView("pending", "vendor", [f("vendor")])).toBe("pending");
    expect(nextView("reorder", "customer", [f("customer")])).toBe("orders");
  });
  it("replaces within a kind and keeps the trail across kinds", () => {
    expect(addFilter([f("vendor", "a")], f("vendor", "b"))).toEqual([f("vendor", "b")]);
    expect(addFilter([f("vendor"), f("customer")], f("design"))).toEqual([f("vendor"), f("customer"), f("design")]);
    expect(removeFilter([f("vendor"), f("customer")], "vendor")).toEqual([f("customer")]);
  });
  it("adds on a row tap but starts fresh from Find, Scan and header links", () => {
    const base: DashState = { view: "vendors", filters: [f("vendor", "a")], range: "all", start: "", end: "", source: null, sort: { key: "value", dir: "asc" }, group: "customer", stock: null };
    expect(withFilter(base, f("customer", "b")).filters).toEqual([f("vendor", "a"), f("customer", "b")]);
    expect(withFilter(base, f("customer", "b"), true).filters).toEqual([f("customer", "b")]);
  });
  it("drops the sort when the view changes and keeps it when it does not", () => {
    const base: DashState = { view: "orders", filters: [], range: "all", start: "", end: "", source: null, sort: { key: "date", dir: "asc" }, group: "customer", stock: null };
    expect(withFilter(base, f("vendor", "a")).sort).toEqual({ key: "date", dir: "asc" });
    expect(withFilter({ ...base, view: "vendors" }, f("vendor", "a")).sort).toBeNull();
  });
  it("lists a customer's unpaid orders first", () => {
    expect(defaultSort("orders", [f("customer")])).toEqual({ key: "balance", dir: "desc" });
    expect(defaultSort("orders", [f("vendor")])).toEqual({ key: "date", dir: "desc" });
  });
});

describe("line rules", () => {
  it("keeps free-typed pieces apart, because they all carry the SKU CUSTOM", () => {
    expect(lineKey({ sku: "CUSTOM", title: "Blue Dupatta" })).toBe("custom:blue dupatta");
    expect(lineKey({ sku: "CUSTOM-3", title: " blue   dupatta " })).toBe("custom:blue dupatta");
    expect(lineKey({ sku: "", title: "Tassel" })).toBe("custom:tassel");
    expect(lineKey({ sku: " dd-sut-plz-008-m-crm ", title: "x" })).toBe("DD-SUT-PLZ-008-M-CRM");
  });
  it("rolls sizes up to the design but keeps colours apart", () => {
    expect(designOf("DD-SUT-PLZ-008-M-CRM")).toBe(designOf("DD-SUT-PLZ-008-XL-CRM"));
    expect(designOf("DD-SUT-PLZ-008-M-CRM")).not.toBe(designOf("DD-SUT-PLZ-008-M-RED"));
    expect(designOf("SHORT-1")).toBe("SHORT-1");
    expect(designOf("custom:tassel")).toBe("custom:tassel");
  });
  it("converts returned billed units to real pieces", () => {
    expect(returnedPieces(line({ qty: 5, actual_qty: 1, returned_qty: 5 }))).toBe(1);
    expect(returnedPieces(line({ qty: 6, actual_qty: 2, returned_qty: 3 }))).toBe(1);
    expect(returnedPieces(line({ qty: 2, returned_qty: 1 }))).toBe(1);
    expect(returnedPieces(line({ qty: 0, returned_qty: 1 }))).toBe(0);
  });
  it("clamps balance per order, so overpaying one order hides nothing on another", () => {
    const paid = order({ total_amount: 10000, advance_amount: 15000 });
    const open = order({ id: "o2", total_amount: 20000 });
    expect(orderBalance(paid) + orderBalance(open)).toBe(20000);
    expect(orderOverpaid(paid)).toBe(5000);
    expect(orderBalance(order({ status: "cancelled", total_amount: 500 }))).toBe(0);
  });
  it("names a party by whatever the exhibition caught", () => {
    const b: DashBuyer = { id: "b", business_name: null, owner_name: "Meera", phone: "+91", city: null };
    expect(partyName(b)).toBe("Meera");
    expect(partyName({ ...b, owner_name: " " })).toBe("+91");
    expect(partyName(null)).toBe("Unknown customer");
  });
  it("does not split a name on case or spacing", () => {
    expect(normName("  Anjali   SILKS ")).toBe(normName("anjali silks"));
  });
});

describe("vendor resolver", () => {
  const vendors = [{ id: "v-anjali", name: "Anjali Silks" }, { id: "v-noor", name: "Noor" }];
  const base = { vendors, receipts: [], lines: [], info: [], designs: [] };
  const SKU = "DD-SUT-PLZ-008-M-CRM";

  it("finds a vendor that only a delivery knows about", () => {
    const out = buildVendorIndex({
      ...base, skus: [SKU],
      receipts: [{ id: "r1", receipt_number: "R-1", receipt_date: "2026-09-01", created_at: "2026-09-01", vendor_id: "v-noor" }],
      lines: [{ receipt_id: "r1", sku: SKU.toLowerCase(), vendor_sku: "N-9" }],
      info: [info(SKU, null)],
    });
    expect(out[SKU]).toEqual({ key: "v-noor", name: "Noor", vendorSku: "N-9" });
  });
  it("trusts the latest delivery over the sheet name", () => {
    const out = buildVendorIndex({
      ...base, skus: [SKU],
      receipts: [
        { id: "r1", receipt_number: "R-1", receipt_date: "2026-08-01", created_at: null, vendor_id: "v-anjali" },
        { id: "r2", receipt_number: "R-2", receipt_date: "2026-09-01", created_at: null, vendor_id: "v-noor" },
      ],
      lines: [{ receipt_id: "r1", sku: SKU, vendor_sku: null }, { receipt_id: "r2", sku: SKU, vendor_sku: null }],
      info: [info(SKU, "Anjali Silks")],
    });
    expect(out[SKU].key).toBe("v-noor");
  });
  it("matches a sheet name to its vendor row however it is spelt", () => {
    const out = buildVendorIndex({ ...base, skus: [SKU], info: [info(SKU, "  anjali  SILKS ")] });
    expect(out[SKU]).toMatchObject({ key: "v-anjali", name: "Anjali Silks" });
  });
  it("groups a name with no vendor row under its commonest spelling", () => {
    const other = "DD-SUT-PLZ-009-M-CRM", third = "DD-SUT-PLZ-010-M-CRM";
    const out = buildVendorIndex({ ...base, skus: [SKU, other, third], info: [info(SKU, "Shree"), info(other, "SHREE"), info(third, "SHREE")] });
    expect(out[SKU].key).toBe(out[other].key);
    expect(out[SKU].name).toBe("SHREE");
  });
  it("ignores a sheet vendor code, which is not a vendor row id", () => {
    const out = buildVendorIndex({ ...base, skus: [SKU], info: [{ ...info(SKU, null), vendor_id: "V-0042" }] });
    expect(out[SKU]).toBeUndefined();
  });
  it("borrows the vendor from another size of the design", () => {
    const m = SKU, xl = "DD-SUT-PLZ-008-XL-CRM";
    const out = buildVendorIndex({ ...base, skus: [m, xl], info: [info(m, "Noor")] });
    expect(out[xl]).toMatchObject({ key: "v-noor", vendorSku: null });
  });
  it("names one vendor for a design: the latest across its sizes", () => {
    const m = SKU, xl = "DD-SUT-PLZ-008-XL-CRM";
    const out = buildVendorIndex({
      ...base, skus: [m, xl],
      receipts: [
        { id: "r1", receipt_number: "R-1", receipt_date: "2026-01-10", created_at: null, vendor_id: "v-anjali" },
        { id: "r2", receipt_number: "R-2", receipt_date: "2026-09-10", created_at: null, vendor_id: "v-noor" },
      ],
      lines: [{ receipt_id: "r1", sku: m, vendor_sku: "A-1" }, { receipt_id: "r2", sku: xl, vendor_sku: "N-2" }],
    });
    expect(out[m].key).toBe("v-noor");
    expect(out[xl]).toMatchObject({ key: "v-noor", vendorSku: "N-2" });
  });
  it("keeps the sheet's vendor code when a delivery did not record one", () => {
    const out = buildVendorIndex({
      ...base, skus: [SKU],
      receipts: [{ id: "r1", receipt_number: "R-1", receipt_date: "2026-09-01", created_at: null, vendor_id: "v-anjali" }],
      lines: [{ receipt_id: "r1", sku: SKU, vendor_sku: null }],
      info: [info(SKU, "Anjali Silks", { vendor_sku: "ANJ-774" })],
    });
    expect(out[SKU].vendorSku).toBe("ANJ-774");
  });
  it("does not borrow a code from a different vendor", () => {
    const out = buildVendorIndex({
      ...base, skus: [SKU],
      receipts: [{ id: "r1", receipt_number: "R-1", receipt_date: "2026-09-01", created_at: null, vendor_id: "v-noor" }],
      lines: [{ receipt_id: "r1", sku: SKU, vendor_sku: null }],
      info: [info(SKU, "Anjali Silks", { vendor_sku: "ANJ-774" })],
    });
    expect(out[SKU].vendorSku).toBeNull();
  });
  it("falls back to the design's first vendor", () => {
    const out = buildVendorIndex({ ...base, skus: [SKU], designs: [{ base_sku: "DD-SUT-PLZ-008", color: "CRM", vendor_id: "v-anjali", vendor_sku: "A-1" }] });
    expect(out[SKU]).toEqual({ key: "v-anjali", name: "Anjali Silks", vendorSku: "A-1" });
  });
});

describe("rollups", () => {
  const anjali = { key: "v-a", name: "Anjali", vendorSku: "A-1" };
  const noor = { key: "v-n", name: "Noor", vendorSku: null };
  const M = "DD-SUT-PLZ-008-M-CRM", XL = "DD-SUT-PLZ-008-XL-CRM", SAREE = "DD-SAR-PRD-001-L-RED", DEAD = "DD-SAR-PRD-002-L-BLU";
  const products = [
    product({ sku: M, current_qty: 3 }), product({ sku: XL, current_qty: -2 }),
    product({ sku: SAREE, title: "Red Saree", category: "Saree", current_qty: 10 }),
    product({ sku: DEAD, title: "Blue Saree", category: "Saree", current_qty: 4 }),
  ];
  const ctx = ctxOf(products, { [M]: anjali, [XL]: anjali, [SAREE]: noor, [DEAD]: anjali });
  const orders = [
    order({ id: "o1", buyer_id: "b1", total_amount: 3300, advance_amount: 1000, exhibition_event: "Nesco", items: [line({ sku: M, qty: 2 }), line({ sku: SAREE, qty: 1, unit_price: 1300 })] }),
    order({ id: "o2", buyer_id: "b2", total_amount: 2000, submitted_at: "2026-09-20T06:00:00Z", source: "in_store", items: [line({ sku: XL, qty: 2 })] }),
    order({ id: "o3", buyer_id: "b1", status: "cancelled", total_amount: 9999, advance_amount: 500, items: [line({ sku: M, qty: 9 })] }),
    order({ id: "o4", buyer_id: "b3", total_amount: 500, items: [line({ sku: "CUSTOM", title: "Tassel", custom: true, qty: 1, unit_price: 500 })] }),
    order({ id: "o5", buyer_id: "b3", total_amount: 700, items: [line({ sku: "CUSTOM", title: "Belt", custom: true, qty: 1, unit_price: 700 })] }),
  ];
  const buyers = new Map<string, DashBuyer>([["b1", { id: "b1", business_name: "Sharma", owner_name: null, phone: null, city: null }]]);
  const flat = flatten(orders, ctx);
  const scope = (filters: Filter[] = [], over: { source?: "exhibition" | "in_store" | null; bounds?: { from: string | null; to: string | null } | null } = {}) =>
    scopeOf(orders, flat, { filters, bounds: over.bounds === undefined ? { from: null, to: null } : over.bounds, source: over.source ?? null });

  it("leaves cancelled orders out of everything", () => {
    expect(flat.every((l) => l.order.status !== "cancelled")).toBe(true);
    expect(summarise(scope()).orders).toBe(4);
  });
  it("rolls sizes into one row, and rows add up to the tile", () => {
    const rows = rollProducts(scope(), ctx);
    const suit = rows.find((r) => r.title === "Rose Suit")!;
    expect(suit.pieces).toBe(4);
    expect(suit.orderIds.size).toBe(2);
    expect(rows.reduce((s, r) => s + r.value, 0)).toBe(summarise(scope()).lineValue);
    expect(rows.reduce((s, r) => s + r.pieces, 0)).toBe(summarise(scope()).pieces);
  });
  it("keeps custom pieces as separate rows", () => {
    const titles = rollProducts(scope(), ctx).map((r) => r.title);
    expect(titles).toContain("Tassel");
    expect(titles).toContain("Belt");
  });
  it("makes a vendor's drill foot to its row", () => {
    const row = rollVendors(scope(), ctx, []).find((r) => r.key === "v-a")!;
    const drill = scope([{ dim: "vendor", value: "v-a" }]);
    expect(summarise(drill).amount).toBe(row.value);
    expect(summarise(drill).pieces).toBe(row.pieces);
    expect(rollProducts(drill, ctx).reduce((s, r) => s + r.value, 0)).toBe(row.value);
    expect(rollCustomers(drill, buyers, {}, { includeCreditOnly: false }).reduce((s, r) => s + r.value, 0)).toBe(row.value);
    expect(rollOrders(drill, buyers).reduce((s, r) => s + r.value, 0)).toBe(row.value);
  });
  it("puts unknown vendors on a row that can still be opened", () => {
    const none = rollVendors(scope(), ctx, []).find((r) => r.key === NONE)!;
    expect(none.name).toBe("No vendor set");
    expect(none.value).toBe(1200);
    expect(summarise(scope([{ dim: "vendor", value: NONE }])).amount).toBe(1200);
  });
  it("adds category rows up to the whole, custom pieces included", () => {
    const rows = rollCategories(scope(), ctx, []);
    expect(rows.reduce((s, r) => s + r.value, 0)).toBe(summarise(scope()).lineValue);
    expect(rows.find((r) => r.key === NONE)?.name).toBe("No category");
  });
  it("narrows to what one customer bought from one vendor", () => {
    const s = scope([{ dim: "vendor", value: "v-a" }, { dim: "customer", value: "b1" }]);
    expect(s.orderLevel).toBe(false);
    expect(summarise(s)).toMatchObject({ orders: 1, pieces: 2, amount: 2000 });
  });
  it("keeps whole-order money under a customer or exhibition filter", () => {
    const s = scope([{ dim: "customer", value: "b1" }]);
    expect(s.orderLevel).toBe(true);
    expect(summarise(s)).toMatchObject({ orders: 1, amount: 3300, advance: 1000, balance: 2300 });
  });
  it("follows the channel chip", () => {
    expect(summarise(scope([], { source: "in_store" })).orders).toBe(1);
  });
  it("shows an order's filtered share beside its total", () => {
    const row = rollOrders(scope([{ dim: "vendor", value: "v-n" }]), buyers)[0];
    expect(row).toMatchObject({ value: 1300, total: 3300, pieces: 1 });
  });
  it("draws the trend to the same figure as the headline", () => {
    for (const s of [scope(), scope([{ dim: "customer", value: "b1" }]), scope([{ dim: "vendor", value: "v-a" }])]) {
      const bars = trendBuckets(trendPoints(s), { from: null, to: null }, "2026-09-30");
      expect(bars.reduce((t, b) => t + b.amount, 0)).toBe(summarise(s).amount);
    }
  });
  it("adds negative stock up as owed, never as less on the shelf", () => {
    expect(stockFor([{ dim: "vendor", value: "v-a" }], ctx)).toEqual({ onHand: 7, owed: 2 });
  });
  it("gives no stock figure where it would mean nothing", () => {
    expect(stockFor([], ctx)).toBeNull();
    expect(stockFor([{ dim: "customer", value: "b1" }], ctx)).toBeNull();
    expect(stockFor([{ dim: "vendor", value: "v-a" }, { dim: "customer", value: "b1" }], ctx)).toBeNull();
  });
  it("narrows In Stock on every tab to what the filters cover", () => {
    const vendor: Filter[] = [{ dim: "vendor", value: "v-a" }];
    const saree = rollCategories(scope(vendor), ctx, vendor).find((r) => r.name === "Suit Set")!;
    expect(saree.stock).toEqual({ onHand: 3, owed: 2 });
    const category: Filter[] = [{ dim: "category", value: "saree" }];
    const noorRow = rollVendors(scope(category), ctx, category).find((r) => r.key === "v-n")!;
    expect(noorRow.stock.onHand).toBe(10);
    expect(stockFor(category, ctx)?.onHand).toBe(14);
  });
  it("keeps a design in one category, whichever size sold", () => {
    const c = ctxOf([product({ sku: M, category: "Kurta", current_qty: 2 }), product({ sku: XL, category: "Suit Set", current_qty: 7 })]);
    const o = [order({ items: [line({ sku: M, qty: 1 }), line({ sku: XL, qty: 2 })] })];
    const f: Filter[] = [{ dim: "category", value: "kurta" }];
    const s = scopeOf(o, flatten(o, c), { filters: f, bounds: { from: null, to: null }, source: null });
    expect(summarise(s).pieces).toBe(3);
    expect(stockFor(f, c)?.onHand).toBe(9);
  });
  it("gives no stock figure for a custom piece", () => {
    expect(stockFor([{ dim: "design", value: "custom:tassel" }], ctx)).toBeNull();
  });
  it("names a design from the order line when no size has a title", () => {
    const c = ctxOf([product({ sku: M, title: null })]);
    const o = [order({ items: [line({ sku: M, title: "Crimson Suit" })] })];
    const s = scopeOf(o, flatten(o, c), { filters: [], bounds: { from: null, to: null }, source: null });
    expect(rollProducts(s, c)[0].title).toBe("Crimson Suit");
  });
  it("shows no sheet code beside a different vendor, and the sheet code when there is no vendor", () => {
    const withInfo = buildContext({
      products: [product({ sku: M }), product({ sku: SAREE })],
      info: [{ sku: M, vendor_name: "Old Mill", vendor_sku: "OM-7", last_cost: 0, last_receipt_date: null }, { sku: SAREE, vendor_name: null, vendor_sku: "ANJ-22", last_cost: 0, last_receipt_date: null }],
      vendorBySku: { [M]: { key: "v-a", name: "Anjali", vendorSku: null } }, categoryBySku: {}, supplyByDesign: {}, grBySku: {},
    });
    const rows = rollReorder(scope(), withInfo, { filters: [], query: "", stock: null });
    expect(rows.find((r) => r.key === M)?.vendorSku).toBeNull();
    expect(rows.find((r) => r.key === SAREE)?.vendorSku).toBe("ANJ-22");
  });
  it("takes a design's details from whichever size has them", () => {
    const c = ctxOf([product({ sku: M, title: null, category: null, image_urls: [] }), product({ sku: XL, title: "Rose Suit", category: "Suit Set", image_urls: ["x.jpg"] })]);
    expect(c.designs.get(designOf(M))).toMatchObject({ title: "Rose Suit", image: "x.jpg", categoryLabel: "Suit Set" });
  });
  it("breaks equal pieces by value", () => {
    const o = [order({ items: [line({ sku: M, qty: 1, unit_price: 100 }), line({ sku: SAREE, qty: 1, unit_price: 900 })] })];
    const s = scopeOf(o, flatten(o, ctx), { filters: [], bounds: { from: null, to: null }, source: null });
    expect(rollProducts(s, ctx)[0].title).toBe("Red Saree");
  });
  it("lists a vendor's designs that did not sell", () => {
    const f: Filter[] = [{ dim: "vendor", value: "v-a" }];
    expect(unsoldDesigns(f, rollProducts(scope(f), ctx), ctx).map((r) => r.title)).toEqual(["Blue Saree"]);
    expect(unsoldDesigns([{ dim: "design", value: "x" }], [], ctx)).toEqual([]);
  });
  it("skips hidden products in the unsold list and in stock", () => {
    const hidden = ctxOf([product({ sku: M, current_qty: 3, wholesale_visible: false })], { [M]: anjali });
    const f: Filter[] = [{ dim: "vendor", value: "v-a" }];
    expect(stockFor(f, hidden)).toEqual({ onHand: 0, owed: 0 });
    expect(unsoldDesigns(f, [], hidden)).toEqual([]);
  });
  it("sums exhibitions from whole orders", () => {
    expect(rollEvents(scope())[0]).toMatchObject({ event: "Nesco", orders: 1, customers: 1, pieces: 3, total: 3300 });
  });
  it("keeps a credit-only party on the customer list", () => {
    const rows = rollCustomers(scope(), buyers, { b9: 500, b1: 0 }, { includeCreditOnly: true });
    expect(rows.find((r) => r.id === "b9")).toMatchObject({ credit: 500, orders: 0 });
    expect(rollCustomers(scope([{ dim: "vendor", value: "v-a" }]), buyers, { b9: 500 }, { includeCreditOnly: false }).some((r) => r.id === "b9")).toBe(false);
  });
  it("dates the oldest unpaid order", () => {
    const rows = rollCustomers(scope(), buyers, {}, { includeCreditOnly: false });
    expect(rows.find((r) => r.id === "b1")?.oldest).toBe("2026-09-10");
  });

  it("nets returns out of Reorder's Sold, in real pieces", () => {
    const o = [order({ items: [line({ sku: M, qty: 6, actual_qty: 2, returned_qty: 3 })] })];
    const s = scopeOf(o, flatten(o, ctx), { filters: [], bounds: { from: null, to: null }, source: null });
    expect(rollReorder(s, ctx, { filters: [], query: "", stock: null }).find((r) => r.key === M)?.sold).toBe(1);
  });
  it("filters Reorder by vendor SKU and by stock", () => {
    const base = { filters: [] as Filter[], query: "", stock: null };
    expect(rollReorder(scope(), ctx, { ...base, query: "a-1" }).map((r) => r.key).sort()).toEqual([DEAD, M, XL].sort());
    expect(rollReorder(scope(), ctx, { ...base, stock: "out" }).map((r) => r.key)).toEqual([XL]);
    expect(rollReorder(scope(), ctx, { ...base, stock: "low" }).map((r) => r.key)).toEqual([XL]);
  });
  it("leaves a discontinued design out of the stock lists", () => {
    const withSupply = buildContext({
      products, info: [], vendorBySku: {}, categoryBySku: {}, grBySku: {},
      supplyByDesign: { [designOf(XL)]: { supply_mode: "discontinued", vendor_stock_qty: null, making_days: null, making_moq: null, delivery_days: null, supply_note: null } },
    });
    expect(rollReorder(scope(), withSupply, { filters: [], query: "", stock: "out" })).toEqual([]);
  });

  describe("pending", () => {
    const open = [
      order({ id: "p1", status: "submitted", items: [line({ sku: SAREE, qty: 4 }), line({ sku: M, qty: 8, line_state: "hold", hold_note: "dye lot" })] }),
      order({ id: "p2", status: "delivered", items: [line({ sku: M, qty: 1 })] }),
      order({ id: "p3", status: "cancelled", items: [line({ sku: M, qty: 1 })] }),
    ];
    const rows = pendingRows(open, ctx, buyers, []);

    it("takes open orders only", () => {
      expect(rows.map((r) => r.order.id)).toEqual(["p1", "p1"]);
    });
    it("does not chase what the shelf can cover", () => {
      const out = chaseByVendor(rows, ctx);
      expect(out.find((v) => v.key === "v-n")).toMatchObject({ chase: 0, covered: [expect.objectContaining({ key: SAREE, need: 4, free: 10 })] });
    });
    it("chases lines on hold and what stock cannot cover", () => {
      const anjaliRow = chaseByVendor(rows, ctx).find((v) => v.key === "v-a")!;
      expect(anjaliRow.chase).toBe(8);
      expect(anjaliRow.skus[0]).toMatchObject({ key: M, need: 8, free: 3, held: 8 });
    });
    it("chases real pieces, not GST-split billed units", () => {
      const split = pendingRows([order({ status: "submitted", items: [line({ sku: DEAD, qty: 18, actual_qty: 6 })] })], ctx, buyers, []);
      expect(split[0].pieces).toBe(6);
      expect(chaseByVendor(split, ctx)[0].skus[0]).toMatchObject({ need: 6, free: 4, chase: 2 });
    });
    it("follows the filters", () => {
      expect(pendingRows(open, ctx, buyers, [{ dim: "vendor", value: "v-n" }]).map((r) => r.key)).toEqual([SAREE]);
    });
  });

  it("works out what a customer owes across all their orders", () => {
    const list = [
      order({ id: "a", total_amount: 10000, advance_amount: 15000 }),
      order({ id: "b", total_amount: 20000, submitted_at: "2020-01-01T00:00:00Z", status: "submitted", items: [line({ qty: 2 })] }),
      order({ id: "c", status: "cancelled", advance_amount: 700, credit_applied: 300 }),
      order({ id: "d", buyer_id: "someone-else", total_amount: 99 }),
    ];
    expect(customerFacts(list, "b1")).toEqual({ owes: 20000, owingOrders: 1, overpaid: 5000, heldOnCancelled: 1000, unsupplied: 2000 });
  });
  it("never says more is unsupplied than the customer owes", () => {
    const pending = [line({ qty: 5 })];
    expect(customerFacts([order({ status: "submitted", total_amount: 5000, advance_amount: 5000, items: pending })], "b1").unsupplied).toBe(0);
    expect(customerFacts([order({ status: "submitted", total_amount: 5000, advance_amount: 4000, items: pending })], "b1").unsupplied).toBe(1000);
  });
});

describe("trend buckets", () => {
  const p = (day: string, amount = 100) => ({ day, amount });

  it("keeps empty days", () => {
    const bars = trendBuckets([p("2026-09-01"), p("2026-09-03")], { from: "2026-09-01", to: "2026-09-03" }, "2026-09-03");
    expect(bars.map((b) => b.amount)).toEqual([100, 0, 100]);
  });
  it("widens to weeks, then months, and loses nothing", () => {
    const pts = [p("2026-01-05"), p("2026-02-20"), p("2026-02-21")];
    const weekly = trendBuckets(pts, { from: "2026-01-01", to: "2026-03-30" }, "2026-03-30");
    expect(weekly[0].from).toBe("2026-01-01"); // the week started 29 Dec; the bar starts with the range
    expect(weekly[weekly.length - 1].to).toBe("2026-03-30");
    expect(weekly.reduce((s, b) => s + b.amount, 0)).toBe(300);
    const monthly = trendBuckets(pts, { from: "2025-01-01", to: "2026-03-30" }, "2026-03-30");
    expect(monthly[0].label).toBe("Jan 2025");
    expect(monthly.reduce((s, b) => s + b.amount, 0)).toBe(300);
  });
  it("never spins on an absurd range", () => {
    expect(trendBuckets([p("2026-01-05")], { from: "1000-01-01", to: "2900-01-01" }, "2026-03-30")).toEqual([]);
  });
  it("has nothing to draw with no sales", () => {
    expect(trendBuckets([], { from: null, to: null }, "2026-09-03")).toEqual([]);
  });
});

describe("find", () => {
  const ctx = ctxOf([product({ sku: "DD-SUT-PLZ-008-M-CRM" })], { "DD-SUT-PLZ-008-M-CRM": { key: "v", name: "Noor", vendorSku: "NR-77" } });
  const index = buildFindIndex({
    ctx,
    buyers: [{ id: "b1", business_name: "Riza Boutique", owner_name: "Meera", phone: "+919876543210", city: "Pune" }],
    contactsByBuyer: { b1: [{ name: "Tara", phone: "+919000011111" }] },
    orders: [order({ order_number: "DX-20260717-012" })],
    vendors: [{ key: "v", name: "Noor" }],
    categories: [{ key: "suit set", name: "Suit Set" }],
    events: ["Nesco 2026"],
  });
  const kinds = (q: string) => searchFind(index, q).map((e) => e.kind);

  it("finds each kind of thing", () => {
    expect(kinds("rose")).toEqual(["design"]);
    expect(kinds("noor")).toEqual(["vendor"]);
    expect(kinds("riza")).toEqual(["customer"]);
    expect(kinds("dx-2026")).toEqual(["order"]);
    expect(kinds("nesco")).toEqual(["event"]);
    expect(kinds("suit set")[0]).toBe("category");
  });
  it("finds a product by the vendor's own code", () => {
    expect(kinds("nr-77")).toEqual(["design"]);
  });
  it("finds a customer by owner, or by the phone of any contact", () => {
    expect(kinds("meera")).toEqual(["customer"]);
    expect(kinds("tara")).toEqual(["customer"]);
    expect(kinds("98765 43210")).toEqual(["customer"]);
    expect(kinds("90000")).toEqual(["customer"]);
  });
  it("waits for two characters", () => {
    expect(searchFind(index, "r")).toEqual([]);
  });
  it("finds an order from part of its number, without mistaking it for a phone", () => {
    expect(kinds("2026071")).toEqual(["order"]);
  });
});

describe("csv", () => {
  it("quotes what needs quoting", () => {
    expect(toCsv(["a", "b"], [['x,"y"', 1]])).toBe('a,b\r\n"x,""y""",1');
  });
  it("defuses a cell that starts like a formula", () => {
    expect(toCsv(["a"], [["=HYPERLINK(1)"]])).toBe("a\r\n'=HYPERLINK(1)");
    expect(toCsv(["a"], [[-5]])).toBe("a\r\n-5");
  });
});

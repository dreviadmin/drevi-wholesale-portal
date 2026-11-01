import { variantLabelOf, baseSkuOf } from "../variants";
import { inBounds, istDay, type Bounds } from "./dates";
import { isOrderLevel, NONE, type Dim, type Filter, type Source, type StockFilter } from "./state";
import {
  designOf, isCustomKey, lineKey, lineValue, normName, orderBalance, orderOverpaid, partyName, pendingState, piecesOf, returnedPieces,
  type DashBuyer, type DashLine, type DashOrder, type PendingState,
} from "./lines";
import type { VendorRef } from "./vendor";

// Every dashboard view is one list of lines narrowed by the same filters, then
// summed by a different key. Same lines, same helpers, so rows foot to the tile.

export interface DashProduct {
  sku: string;
  title: string | null;
  image_urls: string[] | null;
  current_qty: number;
  wholesale_price: number;
  category: string | null; // resolved on the server, sheet then SKU
  restockable: boolean;
  wholesale_visible: boolean;
}
export interface VendorInfo {
  sku: string;
  vendor_name: string | null;
  vendor_sku: string | null;
  last_cost: number;
  last_receipt_date: string | null;
}
export interface DesignSupply {
  supply_mode: string | null;
  vendor_stock_qty: number | null;
  making_days: number | null;
  making_moq: number | null;
  delivery_days: number | null;
  supply_note: string | null;
}
export interface LastGr { cost: number; date: string }

/** Below this a restockable piece is worth a call to the vendor. */
export const LOW_STOCK_QTY = 2;
const OPEN_EXCLUDED = ["cancelled", "delivered", "fulfilled"];

export interface DesignInfo {
  key: string;
  title: string; // blank when no size has one: the order line or the SKU stands in
  image: string | null;
  label: string; // "DD-SUT-PLZ-008 · CRM"
  variants: DashProduct[];
  vendor: VendorRef | null;
  categoryKey: string;
  categoryLabel: string | null;
  supply: DesignSupply | null;
}

export interface DashContext {
  productBySku: Map<string, DashProduct>;
  infoBySku: Map<string, VendorInfo>;
  vendorBySku: Record<string, VendorRef>;
  categoryBySku: Record<string, string | null>;
  supplyByDesign: Record<string, DesignSupply>;
  grBySku: Record<string, LastGr>;
  designs: Map<string, DesignInfo>;
}

export const categoryKeyOf = (label: string | null | undefined) => (label?.trim() ? normName(label) : NONE);

function designLabel(key: string): string {
  if (isCustomKey(key)) return "Custom piece";
  const [base, colour] = key.split("|");
  return colour ? `${base} · ${colour}` : key;
}

export function buildContext(input: {
  products: DashProduct[];
  info: VendorInfo[];
  vendorBySku: Record<string, VendorRef>;
  categoryBySku: Record<string, string | null>;
  supplyByDesign: Record<string, DesignSupply>;
  grBySku: Record<string, LastGr>;
}): DashContext {
  const productBySku = new Map(input.products.map((p) => [p.sku.trim().toUpperCase(), p]));
  const designs = new Map<string, DesignInfo>();
  for (const p of input.products) {
    const sku = p.sku.trim().toUpperCase();
    const key = designOf(sku);
    const d = designs.get(key) ?? {
      key, title: "", image: null, label: designLabel(key), variants: [],
      vendor: null, categoryKey: NONE, categoryLabel: null, supply: input.supplyByDesign[key] ?? null,
    };
    d.variants.push(p);
    // Sizes can be half filled in, so take the first size that knows each thing.
    d.title ||= p.title?.trim() ?? "";
    d.image ??= p.image_urls?.[0] ?? null;
    d.vendor ??= input.vendorBySku[sku] ?? null;
    if (!d.categoryLabel && p.category?.trim()) { d.categoryLabel = p.category; d.categoryKey = categoryKeyOf(p.category); }
    designs.set(key, d);
  }
  return {
    productBySku,
    infoBySku: new Map(input.info.map((v) => [v.sku.trim().toUpperCase(), v])),
    vendorBySku: input.vendorBySku,
    categoryBySku: input.categoryBySku,
    supplyByDesign: input.supplyByDesign,
    grBySku: input.grBySku,
    designs,
  };
}

export interface FlatLine {
  order: DashOrder;
  item: DashLine;
  key: string;
  design: string;
  vendorKey: string;
  categoryKey: string;
  day: string;
  pieces: number;
  value: number;
}

/** One rule for lines and for stock: a design sits in one category, whichever size sold. */
function lineCategoryKey(key: string, ctx: DashContext): string {
  if (isCustomKey(key)) return NONE;
  return ctx.designs.get(designOf(key))?.categoryKey ?? categoryKeyOf(ctx.categoryBySku[key]);
}

/** Every line of every order that counts. Cancelled orders carry no money. */
export function flatten(orders: DashOrder[], ctx: DashContext): FlatLine[] {
  const out: FlatLine[] = [];
  for (const order of orders) {
    if (order.status === "cancelled") continue;
    const day = istDay(order.submitted_at);
    for (const item of order.items ?? []) {
      const key = lineKey(item);
      out.push({
        order, item, key, day,
        design: designOf(key),
        vendorKey: ctx.vendorBySku[key]?.key ?? NONE,
        categoryKey: lineCategoryKey(key, ctx),
        pieces: piecesOf(item),
        value: lineValue(item),
      });
    }
  }
  return out;
}

const orderDimMatches = (o: DashOrder, dim: Dim, value: string) =>
  dim === "customer" ? o.buyer_id === value : dim === "event" ? o.exhibition_event === value : true;

function lineMatches(l: FlatLine, f: Filter): boolean {
  if (f.dim === "vendor") return l.vendorKey === f.value;
  if (f.dim === "design") return l.design === f.value;
  if (f.dim === "category") return l.categoryKey === f.value;
  return orderDimMatches(l.order, f.dim, f.value);
}

export interface Scope {
  orders: DashOrder[];
  lines: FlatLine[];
  orderLevel: boolean; // filters keep whole orders, so total_amount is true
}

export function scopeOf(
  orders: DashOrder[], flat: FlatLine[],
  opts: { filters: Filter[]; bounds: Bounds | null; source: Source | null },
): Scope {
  const { filters, bounds, source } = opts;
  const lines = flat.filter((l) =>
    inBounds(l.day, bounds) && (!source || l.order.source === source) && filters.every((f) => lineMatches(l, f)));
  const orderLevel = isOrderLevel(filters);
  if (!orderLevel) return { lines, orderLevel, orders: Array.from(new Map(lines.map((l) => [l.order.id, l.order])).values()) };
  return {
    lines, orderLevel,
    orders: orders.filter((o) =>
      o.status !== "cancelled" && inBounds(istDay(o.submitted_at), bounds) && (!source || o.source === source)
      && filters.every((f) => orderDimMatches(o, f.dim, f.value))),
  };
}

export interface Summary {
  orders: number;
  pieces: number;
  returned: number;
  amount: number; // Sales when order-level, else line value
  lineValue: number;
  advance: number;
  creditApplied: number;
  balance: number;
  overpaid: number;
}

export function summarise(scope: Scope): Summary {
  const lineTotal = scope.lines.reduce((s, l) => s + l.value, 0);
  const sum = (f: (o: DashOrder) => number) => scope.orders.reduce((s, o) => s + f(o), 0);
  return {
    orders: scope.orders.length,
    pieces: scope.lines.reduce((s, l) => s + l.pieces, 0),
    returned: scope.lines.reduce((s, l) => s + returnedPieces(l.item), 0),
    amount: scope.orderLevel ? sum((o) => o.total_amount || 0) : lineTotal,
    lineValue: lineTotal,
    advance: sum((o) => o.advance_amount || 0),
    creditApplied: sum((o) => Number(o.credit_applied) || 0),
    balance: sum(orderBalance),
    overpaid: sum(orderOverpaid),
  };
}

/** The bars must add up to the headline figure beside them. */
export function trendPoints(scope: Scope): { day: string; amount: number }[] {
  return scope.orderLevel
    ? scope.orders.map((o) => ({ day: istDay(o.submitted_at), amount: o.total_amount || 0 }))
    : scope.lines.map((l) => ({ day: l.day, amount: l.value }));
}

interface Tally { pieces: number; value: number; returned: number; orderIds: Set<string>; customerIds: Set<string>; last: string }
const tally = (): Tally => ({ pieces: 0, value: 0, returned: 0, orderIds: new Set(), customerIds: new Set(), last: "" });
function count(t: Tally, l: FlatLine) {
  t.pieces += l.pieces;
  t.value += l.value;
  t.returned += returnedPieces(l.item);
  t.orderIds.add(l.order.id);
  t.customerIds.add(l.order.buyer_id);
  if (l.day > t.last) t.last = l.day;
}

/** Sums current_qty the safe way: negatives are pieces owed, not less stock on the shelf. */
export interface Stock { onHand: number; owed: number }
function addStock(s: Stock, qty: number) {
  s.onHand += Math.max(0, qty);
  s.owed += Math.max(0, -qty);
}

function stockWhere(ctx: DashContext, test: (d: DesignInfo, p: DashProduct) => boolean): Stock {
  const s: Stock = { onHand: 0, owed: 0 };
  for (const d of ctx.designs.values()) {
    for (const p of d.variants) if (p.wholesale_visible && test(d, p)) addStock(s, p.current_qty);
  }
  return s;
}

const vendorKeyOfSku = (ctx: DashContext, sku: string) => ctx.vendorBySku[sku.trim().toUpperCase()]?.key ?? NONE;

/** Does this catalog row fall inside the filters? Customers and exhibitions say nothing about stock. */
const inCatalogScope = (ctx: DashContext, filters: Filter[]) => (d: DesignInfo, p: DashProduct) => filters.every((f) =>
  f.dim === "vendor" ? vendorKeyOfSku(ctx, p.sku) === f.value
  : f.dim === "category" ? d.categoryKey === f.value
  : f.dim === "design" ? d.key === f.value
  : true);

/** On-hand now for the catalog these filters cover, whatever sold. Null when stock means nothing here. */
export function stockFor(filters: Filter[], ctx: DashContext): Stock | null {
  const dims = filters.map((f) => f.dim);
  if (!dims.length || dims.some((d) => d === "customer" || d === "event")) return null;
  // A custom piece was never in the catalog: no figure, not a zero.
  if (filters.some((f) => f.dim === "design" && !ctx.designs.has(f.value))) return null;
  return stockWhere(ctx, inCatalogScope(ctx, filters));
}

export interface ProductRow extends Tally {
  key: string;
  title: string;
  image: string | null;
  label: string;
  stock: number | null;
}

function productRowFor(key: string, ctx: DashContext, fallback?: DashLine): ProductRow {
  const d = ctx.designs.get(key);
  const stock = d ? d.variants.reduce((s, p) => s + (p.wholesale_visible ? Math.max(0, p.current_qty) : 0), 0) : null;
  return {
    ...tally(), key,
    title: d?.title || fallback?.title || d?.variants[0].sku || key,
    image: d?.image ?? fallback?.image_url ?? null,
    label: d?.label ?? designLabel(key),
    stock,
  };
}

export function rollProducts(scope: Scope, ctx: DashContext): ProductRow[] {
  const map = new Map<string, ProductRow>();
  for (const l of scope.lines) {
    const row = map.get(l.design) ?? productRowFor(l.design, ctx, l.item);
    count(row, l);
    map.set(l.design, row);
  }
  return Array.from(map.values()).sort((a, b) => b.pieces - a.pieces || b.value - a.value);
}

/** Designs these filters cover that did not sell: a vendor's dead stock is the point of asking. */
export function unsoldDesigns(filters: Filter[], sold: ProductRow[], ctx: DashContext): ProductRow[] {
  const dims = filters.map((f) => f.dim);
  if (!dims.length || dims.some((d) => d !== "vendor" && d !== "category")) return [];
  const seen = new Set(sold.map((r) => r.key));
  const out: ProductRow[] = [];
  for (const d of ctx.designs.values()) {
    if (seen.has(d.key)) continue;
    const visible = d.variants.filter((p) => p.wholesale_visible);
    if (!visible.length) continue;
    const inScope = filters.every((f) =>
      f.dim === "vendor" ? visible.some((p) => vendorKeyOfSku(ctx, p.sku) === f.value) : d.categoryKey === f.value);
    if (inScope) out.push(productRowFor(d.key, ctx));
  }
  return out.sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0));
}

export interface GroupRow extends Tally { key: string; name: string; designs: Set<string>; stock: Stock }

function rollBy(
  scope: Scope,
  keyOf: (l: FlatLine) => string,
  nameOf: (key: string, l: FlatLine) => string,
  stockOf: (key: string) => Stock,
): GroupRow[] {
  const map = new Map<string, GroupRow>();
  for (const l of scope.lines) {
    const key = keyOf(l);
    const row = map.get(key) ?? { ...tally(), key, name: nameOf(key, l), designs: new Set<string>(), stock: stockOf(key) };
    count(row, l);
    row.designs.add(l.design);
    map.set(key, row);
  }
  return Array.from(map.values());
}

export function rollVendors(scope: Scope, ctx: DashContext, filters: Filter[]): GroupRow[] {
  const inScope = inCatalogScope(ctx, filters);
  return rollBy(scope, (l) => l.vendorKey,
    (key, l) => (key === NONE ? "No vendor set" : ctx.vendorBySku[l.key]?.name ?? key),
    (key) => stockWhere(ctx, (d, p) => vendorKeyOfSku(ctx, p.sku) === key && inScope(d, p)));
}

export function rollCategories(scope: Scope, ctx: DashContext, filters: Filter[]): GroupRow[] {
  const inScope = inCatalogScope(ctx, filters);
  return rollBy(scope, (l) => l.categoryKey,
    (key, l) => (key === NONE ? "No category" : ctx.designs.get(l.design)?.categoryLabel?.trim() ?? ctx.categoryBySku[l.key]?.trim() ?? key),
    (key) => stockWhere(ctx, (d, p) => d.categoryKey === key && inScope(d, p)));
}

export interface CustomerRow {
  id: string;
  buyer: DashBuyer | null;
  name: string;
  orders: number;
  pieces: number;
  returned: number;
  total: number;
  advance: number;
  balance: number;
  credit: number;
  value: number;
  last: string;
  oldest: string | null; // earliest order still owing
}

export function rollCustomers(
  scope: Scope,
  buyerById: Map<string, DashBuyer>,
  creditByBuyer: Record<string, number>,
  opts: { includeCreditOnly: boolean },
): CustomerRow[] {
  const map = new Map<string, CustomerRow>();
  const row = (id: string): CustomerRow => {
    const hit = map.get(id);
    if (hit) return hit;
    const buyer = buyerById.get(id) ?? null;
    const made: CustomerRow = {
      id, buyer, name: partyName(buyer), orders: 0, pieces: 0, returned: 0, total: 0, advance: 0, balance: 0,
      credit: Number(creditByBuyer[id]) || 0, value: 0, last: "", oldest: null,
    };
    map.set(id, made);
    return made;
  };
  for (const o of scope.orders) {
    const r = row(o.buyer_id);
    const day = istDay(o.submitted_at);
    r.orders += 1;
    r.total += o.total_amount || 0;
    r.advance += o.advance_amount || 0;
    const due = orderBalance(o);
    r.balance += due;
    if (due > 0 && (!r.oldest || day < r.oldest)) r.oldest = day;
    if (day > r.last) r.last = day;
  }
  for (const l of scope.lines) {
    const r = row(l.order.buyer_id);
    r.pieces += l.pieces;
    r.value += l.value;
    r.returned += returnedPieces(l.item);
  }
  // A party holding credit with no order in the period is still a live
  // liability: without this row their wallet is simply invisible here.
  if (opts.includeCreditOnly) {
    for (const [id, balance] of Object.entries(creditByBuyer)) if (Number(balance)) row(id);
  }
  return Array.from(map.values());
}

export interface OrderRow { order: DashOrder; name: string; day: string; pieces: number; value: number; total: number; balance: number }

export function rollOrders(scope: Scope, buyerById: Map<string, DashBuyer>): OrderRow[] {
  const map = new Map<string, OrderRow>();
  for (const o of scope.orders) {
    map.set(o.id, { order: o, name: partyName(buyerById.get(o.buyer_id)), day: istDay(o.submitted_at), pieces: 0, value: 0, total: o.total_amount || 0, balance: orderBalance(o) });
  }
  for (const l of scope.lines) {
    const r = map.get(l.order.id);
    if (r) { r.pieces += l.pieces; r.value += l.value; }
  }
  return Array.from(map.values()).sort((a, b) => b.order.submitted_at.localeCompare(a.order.submitted_at));
}

export interface EventRow { event: string; orders: number; customers: number; pieces: number; value: number; total: number; balance: number; last: string }

export function rollEvents(scope: Scope): EventRow[] {
  const map = new Map<string, EventRow & { ids: Set<string> }>();
  const row = (event: string) => map.get(event) ?? { event, orders: 0, customers: 0, pieces: 0, value: 0, total: 0, balance: 0, last: "", ids: new Set<string>() };
  for (const o of scope.orders) {
    if (!o.exhibition_event) continue;
    const r = row(o.exhibition_event);
    const day = istDay(o.submitted_at);
    r.orders += 1;
    r.ids.add(o.buyer_id);
    r.total += o.total_amount || 0;
    r.balance += orderBalance(o);
    if (day > r.last) r.last = day;
    map.set(o.exhibition_event, r);
  }
  for (const l of scope.lines) {
    if (!l.order.exhibition_event) continue;
    const r = row(l.order.exhibition_event);
    r.pieces += l.pieces;
    r.value += l.value;
    map.set(l.order.exhibition_event, r);
  }
  return Array.from(map.values()).map(({ ids, ...r }) => ({ ...r, customers: ids.size }));
}

export interface ReorderRow {
  p: DashProduct;
  key: string;
  variant: string;
  vendor: VendorRef | null;
  vendorSku: string | null;
  info: VendorInfo | null;
  sold: number; // net of returns: a piece that came back needs no restock
  gr: LastGr | null;
  discontinued: boolean;
}

export function rollReorder(
  scope: Scope, ctx: DashContext,
  opts: { filters: Filter[]; query: string; stock: StockFilter | null },
): ReorderRow[] {
  const sold = new Map<string, number>();
  for (const l of scope.lines) sold.set(l.key, (sold.get(l.key) ?? 0) + l.pieces - returnedPieces(l.item));
  const q = opts.query.trim().toLowerCase();
  const inScope = inCatalogScope(ctx, opts.filters);
  const out: ReorderRow[] = [];
  for (const d of ctx.designs.values()) {
    const discontinued = d.supply?.supply_mode === "discontinued";
    for (const p of d.variants) {
      if (!p.wholesale_visible) continue;
      const key = p.sku.trim().toUpperCase();
      const vendor = ctx.vendorBySku[key] ?? null;
      const info = ctx.infoBySku.get(key) ?? null;
      // Never another vendor's code beside this vendor's name.
      const vendorSku = vendor ? vendor.vendorSku : info?.vendor_sku?.trim() || null;
      if (!inScope(d, p)) continue;
      if (opts.stock === "out" && (p.current_qty > 0 || discontinued)) continue;
      if (opts.stock === "low" && (p.current_qty > LOW_STOCK_QTY || !p.restockable || discontinued)) continue;
      if (q && ![p.sku, p.title, vendor?.name, vendorSku].some((s) => (s ?? "").toLowerCase().includes(q))) continue;
      out.push({
        p, key, variant: variantLabelOf(key), vendor, vendorSku, discontinued, info,
        sold: sold.get(key) ?? 0,
        gr: ctx.grBySku[key] ?? null,
      });
    }
  }
  return out.sort((a, b) => b.sold - a.sold || (a.p.title ?? a.p.sku).localeCompare(b.p.title ?? b.p.sku, "en"));
}

export interface PendingRow {
  order: DashOrder;
  buyer: DashBuyer | null;
  item: DashLine;
  state: PendingState;
  index: number;
  key: string;
  design: string;
  vendorKey: string;
  title: string;
  pieces: number;
}

/** What customers are still owed right now, whatever the date and channel chips say. */
export function pendingRows(orders: DashOrder[], ctx: DashContext, buyerById: Map<string, DashBuyer>, filters: Filter[]): PendingRow[] {
  const rows: PendingRow[] = [];
  for (const order of orders) {
    if (OPEN_EXCLUDED.includes(order.status)) continue;
    (order.items ?? []).forEach((item, index) => {
      const state = pendingState(item, order.status);
      if (!state) return;
      const key = lineKey(item);
      const design = designOf(key);
      const categoryKey = lineCategoryKey(key, ctx);
      const vendorKey = ctx.vendorBySku[key]?.key ?? NONE;
      const ok = filters.every((f) =>
        f.dim === "vendor" ? vendorKey === f.value
        : f.dim === "design" ? design === f.value
        : f.dim === "category" ? categoryKey === f.value
        : orderDimMatches(order, f.dim, f.value));
      if (!ok) return;
      rows.push({
        order, item, state, index, key, design, vendorKey,
        buyer: buyerById.get(order.buyer_id) ?? null,
        title: ctx.productBySku.get(key)?.title || item.title || key,
        pieces: piecesOf(item),
      });
    });
  }
  return rows;
}

export interface PendingGroup { key: string; name: string; image: string | null; pieces: number; rows: PendingRow[] }

function groupPending(rows: PendingRow[], keyOf: (r: PendingRow) => string, nameOf: (r: PendingRow) => string, imageOf?: (r: PendingRow) => string | null): PendingGroup[] {
  const map = new Map<string, PendingGroup>();
  for (const r of rows) {
    const key = keyOf(r);
    const g = map.get(key) ?? { key, name: nameOf(r), image: imageOf?.(r) ?? null, pieces: 0, rows: [] };
    g.pieces += r.pieces;
    g.rows.push(r);
    map.set(key, g);
  }
  return Array.from(map.values()).sort((a, b) => b.pieces - a.pieces);
}

export const pendingByCustomer = (rows: PendingRow[]) => groupPending(rows, (r) => r.order.buyer_id, (r) => partyName(r.buyer));
export const pendingByProduct = (rows: PendingRow[], ctx: DashContext) => groupPending(
  rows, (r) => r.design,
  (r) => ctx.designs.get(r.design)?.title || r.title,
  (r) => ctx.designs.get(r.design)?.image ?? r.item.image_url ?? null,
);

export interface ChaseSku { key: string; design: string; title: string; label: string; vendorSku: string | null; need: number; free: number; held: number; chase: number }
export interface ChaseVendor { key: string; name: string; chase: number; held: number; skus: ChaseSku[]; covered: ChaseSku[] }

/**
 * Pending does not mean short: every line of a fresh order is unconfirmed even
 * with 50 on the shelf. A vendor only needs chasing for lines on hold and for
 * what the free stock cannot cover, worked out per SKU and never across a vendor.
 */
export function chaseByVendor(rows: PendingRow[], ctx: DashContext): ChaseVendor[] {
  const bySku = new Map<string, { row: PendingRow; need: number; held: number }>();
  for (const r of rows) {
    const e = bySku.get(r.key) ?? { row: r, need: 0, held: 0 };
    e.need += r.pieces; // real pieces: a vendor delivers cloth, not GST-split billed units
    if (r.state === "hold") e.held += r.pieces;
    bySku.set(r.key, e);
  }
  const vendors = new Map<string, ChaseVendor>();
  for (const [key, { row, need, held }] of bySku) {
    const free = Math.max(0, ctx.productBySku.get(key)?.current_qty ?? 0);
    const chase = Math.max(Math.max(0, need - free), held);
    const v = vendors.get(row.vendorKey) ?? {
      key: row.vendorKey, name: row.vendorKey === NONE ? "No vendor set" : ctx.vendorBySku[key]?.name ?? row.vendorKey,
      chase: 0, held: 0, skus: [], covered: [],
    };
    const sku: ChaseSku = {
      key, design: row.design, title: row.title, label: isCustomKey(key) ? "Custom piece" : `${baseSkuOf(key)} · ${variantLabelOf(key)}`,
      vendorSku: ctx.vendorBySku[key]?.vendorSku ?? null, need, free, held, chase,
    };
    v.chase += chase;
    v.held += held;
    (chase > 0 ? v.skus : v.covered).push(sku);
    vendors.set(row.vendorKey, v);
  }
  for (const v of vendors.values()) v.skus.sort((a, b) => b.chase - a.chase);
  return Array.from(vendors.values()).sort((a, b) => b.chase - a.chase);
}

export interface CustomerFacts {
  owes: number;
  owingOrders: number;
  overpaid: number;
  heldOnCancelled: number;
  unsupplied: number;
}

/** What a customer owes today. All their orders, whatever the date or channel chips say. */
export function customerFacts(orders: DashOrder[], buyerId: string): CustomerFacts {
  const facts: CustomerFacts = { owes: 0, owingOrders: 0, overpaid: 0, heldOnCancelled: 0, unsupplied: 0 };
  for (const o of orders) {
    if (o.buyer_id !== buyerId) continue;
    if (o.status === "cancelled") {
      facts.heldOnCancelled += (o.advance_amount || 0) + (Number(o.credit_applied) || 0);
      continue;
    }
    const due = orderBalance(o);
    facts.owes += due;
    if (due > 0) facts.owingOrders += 1;
    facts.overpaid += orderOverpaid(o);
    // Part of what they owe: a paid order's open lines are not, and an order
    // can never claim more than its own balance.
    const open = (o.items ?? []).reduce((s, it) => s + (pendingState(it, o.status) ? lineValue(it) : 0), 0);
    facts.unsupplied += Math.min(due, open);
  }
  return facts;
}

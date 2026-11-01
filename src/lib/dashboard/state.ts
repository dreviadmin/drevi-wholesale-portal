import { isDay, type Range } from "./dates";

// The dashboard's state lives in the URL, so Back undoes a tap, a link can be
// shared, and returning from an order lands on the same view. Pure, so the
// rules below are pinned by vitest.

export type Dim = "vendor" | "design" | "customer" | "category" | "event";
export type View = "products" | "vendors" | "customers" | "orders" | "pending" | "reorder" | "category" | "events";
export type Source = "exhibition" | "in_store" | "portal_self_service";
export type PendingGroup = "customer" | "product" | "vendor";
export type StockFilter = "low" | "out";
export type SortDir = "asc" | "desc";

export interface Filter { dim: Dim; value: string }
export interface SortState { key: string; dir: SortDir }
export interface DashState {
  view: View;
  filters: Filter[]; // in the order they were added
  range: Range;
  start: string;
  end: string;
  source: Source | null;
  sort: SortState | null;
  group: PendingGroup;
  stock: StockFilter | null;
}

/** The "No vendor set" and "No category" rows filter too. */
export const NONE = "__none__";

const VIEWS: View[] = ["products", "vendors", "customers", "orders", "pending", "reorder", "category", "events"];
const DIMS: Dim[] = ["vendor", "design", "customer", "category", "event"];
const RANGES: Range[] = ["today", "7d", "30d", "mtd", "all", "custom"];
const SOURCES: Source[] = ["exhibition", "in_store", "portal_self_service"];

/** Filters that narrow to whole orders, so order-level money stays true. */
const ORDER_DIMS: Dim[] = ["customer", "event"];
export const isOrderLevel = (filters: Filter[]) => filters.every((f) => ORDER_DIMS.includes(f.dim));
export const hasDim = (filters: Filter[], dim: Dim) => filters.some((f) => f.dim === dim);
export const valueOf = (filters: Filter[], dim: Dim) => filters.find((f) => f.dim === dim)?.value ?? null;

/** What is left to look at once these filters are on. */
export function availableViews(filters: Filter[]): View[] {
  const on = (d: Dim) => hasDim(filters, d);
  return VIEWS.filter((v) => {
    if (v === "products") return !on("design");
    if (v === "customers") return !on("customer");
    if (v === "vendors") return !on("vendor") && !on("design");
    if (v === "category") return !on("category") && !on("design");
    if (v === "reorder") return !on("customer") && !on("event");
    if (v === "events") return !on("event");
    return true;
  });
}

export function resolveView(view: View, filters: Filter[]): View {
  const available = availableViews(filters);
  return available.includes(view) ? view : available[0];
}

/**
 * Where a row tap lands. Reorder, Pending and Orders are tasks, so a filter
 * applied there stays there; anywhere else it opens what is most useful next.
 */
export function nextView(current: View, dim: Dim, filters: Filter[]): View {
  const available = availableViews(filters);
  if ((current === "reorder" || current === "pending" || current === "orders") && available.includes(current)) return current;
  const wanted: View[] =
    dim === "design" ? ["customers", "orders"]
    : dim === "customer" ? (filters.length > 1 ? ["products", "orders"] : ["orders", "products"])
    : dim === "event" ? ["customers", "orders"]
    : ["products", "orders"];
  return wanted.find((v) => available.includes(v)) ?? available[0];
}

/** A row tap adds a filter, one per kind. The chips read as the path taken, so each can be undone. */
export function addFilter(filters: Filter[], next: Filter): Filter[] {
  return [...filters.filter((f) => f.dim !== next.dim), next];
}

export function removeFilter(filters: Filter[], dim: Dim): Filter[] {
  return filters.filter((f) => f.dim !== dim);
}

/** A row tap adds to what is there. Find, Scan and header links start fresh on the one thing. */
export function withFilter(state: DashState, filter: Filter, fresh = false): DashState {
  const filters = fresh ? [filter] : addFilter(state.filters, filter);
  const view = nextView(state.view, filter.dim, filters);
  return { ...state, filters, view, sort: view === state.view ? state.sort : null };
}

const SORT_KEYS: Record<View, string[]> = {
  products: ["product", "pieces", "value", "orders", "customers", "returned", "stock", "last"],
  vendors: ["vendor", "designs", "pieces", "value", "orders", "customers", "stock"],
  customers: ["customer", "orders", "pieces", "total", "advance", "credit", "balance", "last", "oldest"],
  orders: ["order", "date", "customer", "pieces", "total", "balance", "status", "source"],
  pending: [],
  reorder: ["product", "vendor", "vendorSku", "cost", "grCost", "grDate", "sold", "stock"],
  category: ["category", "designs", "pieces", "value", "orders", "stock"],
  events: ["event", "orders", "customers", "pieces", "total", "balance"],
};

/** The money columns only exist while the filters keep whole orders. */
export function sortKeysFor(view: View, filters: Filter[]): string[] {
  if (isOrderLevel(filters)) return SORT_KEYS[view];
  if (view === "customers") return ["customer", "orders", "pieces", "value", "last"];
  if (view === "orders") return ["order", "date", "customer", "pieces", "value", "total", "status", "source"];
  if (view === "events") return ["event", "orders", "customers", "pieces", "value"];
  return SORT_KEYS[view];
}

export function defaultSort(view: View, filters: Filter[]): SortState {
  const lines = !isOrderLevel(filters);
  switch (view) {
    case "products": return { key: "pieces", dir: "desc" };
    case "customers": return lines ? { key: "value", dir: "desc" } : { key: "total", dir: "desc" };
    case "orders": return hasDim(filters, "customer") && !lines ? { key: "balance", dir: "desc" } : { key: "date", dir: "desc" };
    case "reorder": return { key: "sold", dir: "desc" };
    case "events": return lines ? { key: "value", dir: "desc" } : { key: "total", dir: "desc" };
    default: return { key: "value", dir: "desc" };
  }
}

interface Params { get(name: string): string | null; getAll(name: string): string[] }

export function parseDashState(params: Params | null, defaultView: View): DashState {
  const get = (name: string) => params?.get(name) ?? null;
  const filters = (params?.getAll("f") ?? []).reduce<Filter[]>((out, raw) => {
    // Vendor names and custom titles can hold colons: split on the first only.
    const at = raw.indexOf(":");
    if (at < 1) return out;
    const dim = raw.slice(0, at) as Dim;
    const value = raw.slice(at + 1);
    if (!DIMS.includes(dim) || !value) return out;
    return [...out.filter((f) => f.dim !== dim), { dim, value }];
  }, []);

  const rawView = get("view") as View | null;
  const view = resolveView(rawView && VIEWS.includes(rawView) ? rawView : defaultView, filters);
  const rawRange = get("range") as Range | null;
  const rawSource = get("source") as Source | null;
  const date = (name: string) => { const v = get(name) ?? ""; return isDay(v) ? v : ""; };

  const [sortKey, sortDir] = (get("sort") ?? "").split(".");
  const sort = sortKeysFor(view, filters).includes(sortKey) && (sortDir === "asc" || sortDir === "desc")
    ? { key: sortKey, dir: sortDir as SortDir }
    : null;

  const group = get("group");
  const stock = get("stock");
  return {
    view,
    filters,
    range: rawRange && RANGES.includes(rawRange) ? rawRange : "all",
    start: date("start"),
    end: date("end"),
    source: rawSource && SOURCES.includes(rawSource) ? rawSource : null,
    sort,
    group: group === "product" || group === "vendor" ? group : "customer",
    stock: stock === "low" || stock === "out" ? stock : null,
  };
}

/** One path to a query string, so comparing two URLs means something. */
export function serializeDashState(state: DashState): string {
  const q = new URLSearchParams();
  q.set("view", state.view); // always written: /admin/reorder defaults differently
  for (const f of state.filters) q.append("f", `${f.dim}:${f.value}`);
  if (state.range !== "all") q.set("range", state.range);
  if (state.range === "custom" && state.start) q.set("start", state.start);
  if (state.range === "custom" && state.end) q.set("end", state.end);
  if (state.source) q.set("source", state.source);
  if (state.sort) q.set("sort", `${state.sort.key}.${state.sort.dir}`);
  if (state.view === "pending" && state.group !== "customer") q.set("group", state.group);
  if (state.view === "reorder" && state.stock) q.set("stock", state.stock);
  return q.toString();
}

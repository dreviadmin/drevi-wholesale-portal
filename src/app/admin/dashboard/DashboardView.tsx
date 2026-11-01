"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, X } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { fmtDay, isDay, istDay, rangeBounds, type Range } from "@/lib/dashboard/dates";
import {
  availableViews, defaultSort, isOrderLevel, NONE, removeFilter, resolveView, serializeDashState, valueOf, withFilter,
  type DashState, type Filter, type Source, type View,
} from "@/lib/dashboard/state";
import { designOf, partyName, plural } from "@/lib/dashboard/lines";
import {
  buildContext, categoryKeyOf, flatten, pendingRows, scopeOf, stockFor, summarise, trendPoints,
} from "@/lib/dashboard/rollup";
import { trendBuckets, type TrendBucket } from "@/lib/dashboard/trend";
import { buildFindIndex, type FindEntry } from "@/lib/dashboard/find";
import { DrillLink } from "./DrillTable";
import { EntityHeader } from "./EntityHeader";
import { FindBox } from "./FindBox";
import { PendingView } from "./PendingView";
import { TrendStrip } from "./TrendStrip";
import { CategoryView, CustomersView, EventsView, OrdersView, ProductsView, ReorderView, VendorsView, type ViewProps } from "./views";
import { useDashState, type Nav } from "./useDashState";
import type { DashboardData } from "./load";

const VIEW_LABEL: Record<View, string> = {
  products: "Products", vendors: "Vendors", customers: "Customers", orders: "Orders", pending: "Pending",
  reorder: "Reorder", category: "Categories", events: "Exhibitions",
};
const RANGE_LABEL: Record<Range, string> = { today: "Today", "7d": "7 Days", "30d": "30 Days", mtd: "This Month", all: "All Time", custom: "Custom" };
const SOURCE_LABEL: Record<Source, string> = { exhibition: "Exhibition", in_store: "In-store", portal_self_service: "Portal" };
const VIEW_NOUN: Partial<Record<View, string>> = { products: "items sold", vendors: "items sold", category: "items sold", customers: "orders", orders: "orders", events: "exhibition orders", reorder: "products" };

function periodLabel(state: DashState): string {
  if (state.range !== "custom") return RANGE_LABEL[state.range];
  if (state.start && state.start === state.end) return fmtDay(state.start);
  if (state.start && state.end) return `${fmtDay(state.start)} to ${fmtDay(state.end)}`;
  return state.start ? `From ${fmtDay(state.start)}` : state.end ? `To ${fmtDay(state.end)}` : "Pick dates";
}

/** The period as words in a sentence, where the chip's label would read "in Today". */
function periodPhrase(state: DashState): string {
  if (state.range === "today") return "today";
  if (state.range === "7d") return "in the last 7 days";
  if (state.range === "30d") return "in the last 30 days";
  if (state.range === "mtd") return "this month";
  if (state.range === "all") return "so far";
  if (state.start && state.start === state.end) return `on ${fmtDay(state.start)}`;
  if (state.start && state.end) return `from ${fmtDay(state.start)} to ${fmtDay(state.end)}`;
  if (state.start) return `from ${fmtDay(state.start)}`;
  return state.end ? `up to ${fmtDay(state.end)}` : "for the dates you pick";
}

const chipStyle = (on: boolean): React.CSSProperties => ({
  fontSize: 9.5, letterSpacing: "0.14em", padding: "6px 12px", whiteSpace: "nowrap",
  background: on ? palette.goldDeep : "transparent", color: on ? palette.ivory : palette.softBlack,
  border: on ? "none" : "1px solid rgba(26,26,26,0.18)",
});

function CustomRange({ nav }: { nav: Nav }) {
  const { state } = nav;
  const [from, setFrom] = useState(state.start);
  const [to, setTo] = useState(state.end);
  useEffect(() => { setFrom(state.start); setTo(state.end); }, [state.start, state.end]);
  const ready = (v: string) => v === "" || isDay(v); // a half-typed year is not a date yet
  const input = { border: "1px solid rgba(26,26,26,0.18)", padding: "4px 6px", fontSize: 11 };
  return (
    <span className="flex items-center gap-1.5 font-body flex-none" style={{ fontSize: 10, color: palette.mutedGreige }}>
      <input type="date" value={from} aria-label="From date" style={input} onChange={(e) => { setFrom(e.target.value); if (ready(e.target.value)) nav.go({ ...state, start: e.target.value }); }} />
      –
      <input type="date" value={to} aria-label="To date" style={input} onChange={(e) => { setTo(e.target.value); if (ready(e.target.value)) nav.go({ ...state, end: e.target.value }); }} />
    </span>
  );
}

function Tile({ label, value, sub, accent, href, onGo, external, phone }: {
  label: string; value: string; sub?: string; accent?: boolean; href?: string; onGo?: () => void; external?: boolean; phone?: boolean;
}) {
  const body = (
    <div style={{ background: accent ? palette.black : palette.ivoryDeep, padding: "10px 12px", minWidth: 0, height: "100%" }}>
      <div className="font-body uppercase truncate" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: accent ? palette.champagne ?? palette.gold : palette.softBlack }}>{label}</div>
      <div className="font-display truncate" style={{ fontSize: 19, fontWeight: 600, color: accent ? palette.ivory : palette.black, marginTop: 2 }}>{value}</div>
      {sub && <div className="font-body truncate" style={{ fontSize: 9.5, color: accent ? palette.champagne : palette.mutedGreige }}>{sub}</div>}
    </div>
  );
  const cls = phone ? "block" : "hidden md:block";
  if (href && external) return <Link href={href} prefetch={false} className={cls}>{body}</Link>;
  if (href && onGo) return <DrillLink href={href} onGo={onGo} className={cls} label={`${label}: ${value}`}>{body}</DrillLink>;
  return <div className={cls}>{body}</div>;
}

function FilterBar({ nav, labelOf }: { nav: Nav; labelOf: (f: Filter) => string }) {
  const { state } = nav;
  const strip = (filters: Filter[]) => nav.open({ ...state, filters, view: resolveView(state.view, filters) });
  const removeBtn = { width: 28, height: 28, margin: "-4px -6px -4px 0" };
  const chip = { fontSize: 11.5, padding: "4px 6px 4px 9px", background: palette.ivory, border: `1px solid ${palette.gold}`, color: palette.black, maxWidth: 170 };
  const customer = valueOf(state.filters, "customer");
  const others = state.filters.filter((f) => f.dim !== "customer");
  const lineFilters = !isOrderLevel(state.filters);
  return (
    <nav aria-label="Active filters" className="sticky top-[83px] md:top-0 z-30" style={{ background: palette.pageBg, padding: "6px 0" }}>
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        {state.filters.length > 0 && (
          <button type="button" aria-label="Back one step" onClick={() => nav.back(() => {
            // Opened from a link, so there is no path to retrace: step down without a new Back entry.
            const filters = state.filters.slice(0, -1);
            nav.go({ ...state, filters, view: resolveView(state.view, filters) });
          })} className="flex items-center justify-center flex-none" style={{ width: 28, height: 28, border: "1px solid rgba(26,26,26,0.18)" }}>
            <ChevronLeft size={15} color={palette.softBlack} />
          </button>
        )}
        {state.filters.map((f) => (
          <span key={f.dim} className="inline-flex items-center gap-1 font-body flex-none" style={chip}>
            <span className="truncate">{labelOf(f)}</span>
            <button type="button" aria-label={`Remove ${labelOf(f)}`} onClick={() => strip(removeFilter(state.filters, f.dim))} className="flex items-center justify-center flex-none" style={removeBtn}><X size={13} color={palette.mutedGreige} /></button>
          </span>
        ))}
        {state.source && (
          <span className="inline-flex items-center gap-1 font-body flex-none" style={{ ...chip, borderColor: "rgba(26,26,26,0.18)" }}>
            {SOURCE_LABEL[state.source]}
            <button type="button" aria-label="Show every channel" onClick={() => nav.go({ ...state, source: null })} className="flex items-center justify-center flex-none" style={removeBtn}><X size={13} color={palette.mutedGreige} /></button>
          </span>
        )}
        <span className="font-body flex-none" style={{ fontSize: 10.5, color: palette.mutedGreige }}>{periodLabel(state)}</span>
        {state.filters.length > 1 && (
          <button type="button" onClick={() => strip([])} className="font-body uppercase flex-none" style={{ fontSize: 9.5, letterSpacing: "0.12em", padding: "8px 4px", color: palette.goldDeep, textDecoration: "underline" }}>Clear</button>
        )}
      </div>
      {customer && lineFilters && (
        <p className="font-body mt-1" style={{ fontSize: 10.5, color: palette.softBlack }}>
          Only {labelOf({ dim: "customer", value: customer })}&apos;s orders for {others.map(labelOf).join(" and ")}, not their full total.
        </p>
      )}
    </nav>
  );
}

function EmptyState({ nav, noun, lastLabel, query, onClearQuery }: {
  nav: Nav; noun: string; lastLabel: string | null; query: string; onClearQuery: () => void;
}) {
  const { state } = nav;
  const last = state.filters[state.filters.length - 1];
  const button = { fontSize: 9.5, letterSpacing: "0.12em", padding: "7px 12px", border: "1px solid rgba(26,26,26,0.18)", color: palette.softBlack };
  const reorder = state.view === "reorder"; // built from the catalog, so dates cannot empty it
  if (!reorder && state.range === "custom" && !state.start && !state.end) {
    return <p className="font-body mt-4" style={{ fontSize: 12, color: palette.mutedGreige }}>Pick a from or to date above.</p>;
  }
  const searching = reorder && query.trim() !== "";
  const stocked = reorder && state.stock !== null;
  const scopeWord = lastLabel ? ` for ${lastLabel}` : "";
  const widen = state.range !== "all" && state.source ? "Show everything" : state.range !== "all" ? "Show all time" : "Show all channels";
  const message = searching ? `No products match “${query.trim()}”${scopeWord}.`
    : stocked ? `Nothing ${state.stock === "out" ? "sold out" : "low on stock"}${scopeWord}.`
    : reorder ? `No products${scopeWord}.`
    : `No ${noun}${scopeWord} ${periodPhrase(state)}${state.source ? ` through ${SOURCE_LABEL[state.source]}` : ""}.`;
  return (
    <div className="mt-4">
      <p className="font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>{message}</p>
      <div className="flex gap-2 mt-2 flex-wrap">
        {searching && <button type="button" onClick={onClearQuery} className="font-body uppercase" style={button}>Clear search</button>}
        {stocked && <button type="button" onClick={() => nav.go({ ...state, stock: null })} className="font-body uppercase" style={button}>All stock</button>}
        {!reorder && (state.range !== "all" || state.source) && (
          <button type="button" onClick={() => nav.go({ ...state, range: "all", start: "", end: "", source: null })} className="font-body uppercase" style={button}>{widen}</button>
        )}
        {last && lastLabel && (
          <button type="button" onClick={() => { const filters = removeFilter(state.filters, last.dim); nav.open({ ...state, filters, view: resolveView(state.view, filters) }); }} className="font-body uppercase" style={button}>Remove {lastLabel}</button>
        )}
      </div>
    </div>
  );
}

export function DashboardView({
  orders, buyers, contactsByBuyer, products, info, vendorBySku, vendorProfiles, categoryBySku, supplyByDesign,
  grBySku = {}, creditByBuyer = {}, serverNow, initialView,
}: DashboardData & { initialView?: View }) {
  const nav = useDashState(initialView ?? "products");
  const { state } = nav;
  const router = useRouter();
  const reorderRoute = initialView === "reorder" && state.view === "reorder"; // the task page itself, not a tab reached from it

  // The server's clock on first paint so both renders agree, then the real one:
  // a tablet left open overnight must still know what today is.
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => document.removeEventListener("visibilitychange", tick);
  }, []);
  const clock = state.range === "all" || state.range === "custom" ? 0 : now;

  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scannedSku, setScanned] = useState<string | null>(null);

  const ctx = useMemo(
    () => buildContext({ products, info, vendorBySku, categoryBySku, supplyByDesign, grBySku }),
    [products, info, vendorBySku, categoryBySku, supplyByDesign, grBySku],
  );
  const buyerById = useMemo(() => new Map(buyers.map((b) => [b.id, b])), [buyers]);
  const profileById = useMemo(() => new Map(vendorProfiles.map((v) => [v.id, v])), [vendorProfiles]);
  const flat = useMemo(() => flatten(orders, ctx), [orders, ctx]);

  const bounds = useMemo(() => rangeBounds(state.range, state.start, state.end, clock), [state.range, state.start, state.end, clock]);
  const scope = useMemo(
    () => scopeOf(orders, flat, { filters: state.filters, bounds, source: state.source }),
    [orders, flat, state.filters, bounds, state.source],
  );
  const summary = useMemo(() => summarise(scope), [scope]);
  const pending = useMemo(() => pendingRows(orders, ctx, buyerById, state.filters), [orders, ctx, buyerById, state.filters]);
  const pendingPieces = useMemo(() => pending.reduce((s, r) => s + r.pieces, 0), [pending]);
  const stock = useMemo(() => stockFor(state.filters, ctx), [state.filters, ctx]);
  const scanned = scannedSku && valueOf(state.filters, "design") === designOf(scannedSku) ? scannedSku : null;
  const buckets = useMemo(() => trendBuckets(trendPoints(scope), bounds, istDay(now)), [scope, bounds, now]);
  const sort = useMemo(() => state.sort ?? defaultSort(state.view, state.filters), [state.sort, state.view, state.filters]);
  // Show-more and expanded lists start over on a new view, not on a new sort.
  const viewKey = useMemo(() => serializeDashState({ ...state, sort: null }), [state]);

  // What the business still owes its parties in unspent credit. All-time by
  // definition, so it ignores the range chips.
  const creditOutstanding = useMemo(() => Object.values(creditByBuyer).reduce((s, v) => s + (Number(v) || 0), 0), [creditByBuyer]);

  const vendorList = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of Object.values(vendorBySku)) map.set(v.key, v.name);
    return Array.from(map, ([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  }, [vendorBySku]);
  const categoryList = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of ctx.designs.values()) if (d.categoryLabel) map.set(d.categoryKey, d.categoryLabel);
    for (const label of Object.values(categoryBySku)) if (label) map.set(categoryKeyOf(label), label);
    return Array.from(map, ([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  }, [ctx, categoryBySku]);
  const events = useMemo(() => Array.from(new Set(orders.map((o) => o.exhibition_event).filter((e): e is string => !!e))), [orders]);
  const findIndex = useMemo(() => {
    const extra = vendorProfiles.filter((v) => !vendorList.some((x) => x.key === v.id)).map((v) => ({ key: v.id, name: v.name }));
    return buildFindIndex({ ctx, buyers, contactsByBuyer, orders, vendors: [...vendorList, ...extra], categories: categoryList, events });
  }, [ctx, buyers, contactsByBuyer, orders, vendorProfiles, vendorList, categoryList, events]);

  const buyerPhone = (id: string) => buyerById.get(id)?.phone?.trim() || contactsByBuyer[id]?.find((c) => c.phone)?.phone || null;
  const profileByKey = (key: string) => profileById.get(key) ?? null;
  const vendorPhone = (key: string) => profileByKey(key)?.phone ?? null;

  function labelOf(f: Filter): string {
    if (f.dim === "vendor") return f.value === NONE ? "No vendor set" : profileById.get(f.value)?.name ?? vendorList.find((v) => v.key === f.value)?.name ?? "Vendor not found";
    if (f.dim === "customer") return partyName(buyerById.get(f.value));
    if (f.dim === "category") return f.value === NONE ? "No category" : categoryList.find((c) => c.key === f.value)?.name ?? f.value;
    if (f.dim === "design") return ctx.designs.get(f.value)?.title || flat.find((l) => l.design === f.value)?.item.title || ctx.designs.get(f.value)?.label || f.value;
    return f.value;
  }

  // A filter tap can start far down a long list, so bring the answer up to meet it.
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!nav.justOpened.current) return;
    nav.justOpened.current = false;
    resultsRef.current?.scrollIntoView({ block: "start" });
    resultsRef.current?.focus({ preventScroll: true });
  }, [nav.here, nav.justOpened]);

  // Keep the chosen tab in sight: there are more than a phone can show at once.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>("[aria-current='page']");
    if (strip && tab) strip.scrollLeft = tab.offsetLeft - strip.offsetLeft - 16;
  }, [state.view]);

  function pickFound(entry: FindEntry) {
    setScanned(null);
    if (entry.kind === "order") router.push(nav.onward(`/admin/orders/${entry.value}`));
    else nav.open({ ...withFilter(state, { dim: entry.kind, value: entry.value }, true), stock: null });
  }

  // Golden rule: every search has a scan. A hit opens the design, sizes and all.
  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    const p = ctx.productBySku.get(sku);
    if (!p) return { ok: false, message: `${sku || "Empty scan"} — not on the portal` };
    setScanning(false);
    setScanned(sku);
    setQuery(""); // leftover text or a stock chip must not hide what was just scanned
    nav.open({ ...withFilter(state, { dim: "design", value: designOf(sku) }, true), stock: null });
    const v = vendorBySku[sku];
    return { ok: true, message: v?.name ? `${p.title ?? p.sku} — ${v.name}` : p.title ?? p.sku };
  }

  const views = availableViews(state.filters);
  const canSee = (v: View) => views.includes(v);
  // The default sort stays out of the URL, so a tile that changes nothing adds no Back step.
  const toView = (view: View, sortKey?: string, dir: "asc" | "desc" = "desc"): DashState => {
    const fallback = defaultSort(view, state.filters);
    return { ...state, view, sort: sortKey && (sortKey !== fallback.key || dir !== fallback.dir) ? { key: sortKey, dir } : null };
  };
  const tile = (next: DashState) => ({ href: nav.hrefFor(next), onGo: () => nav.open(next) });

  const orderLevel = scope.orderLevel;
  const customerAlone = orderLevel && !!valueOf(state.filters, "customer");
  const balanceLabel = state.range !== "all" ? "Balance (this period)" : state.source ? "Balance (this channel)" : "Balance Due";
  const creditSub = summary.creditApplied > 0 ? `plus ${formatINR(summary.creditApplied)} credit` : undefined;
  const lastFilter = state.filters[state.filters.length - 1] ?? null;
  const balanceTarget = canSee("customers") ? toView("customers", "balance") : toView("orders", "balance");
  const advanceTarget = canSee("customers") ? toView("customers", "advance") : toView("orders", "date");
  const piecesTarget = canSee("products") ? toView("products", "pieces") : toView(views[0]);
  const countText = `${plural(summary.orders, "order")} · ${plural(summary.pieces, "piece")}`;
  const returnedText = summary.returned > 0 ? `${summary.returned} returned, still counted here` : undefined;
  const adjustment = summary.amount - summary.lineValue;

  const empty = (
    <EmptyState nav={nav} noun={VIEW_NOUN[state.view] ?? "results"} lastLabel={lastFilter ? labelOf(lastFilter) : null} query={query} onClearQuery={() => setQuery("")} />
  );
  const viewProps: ViewProps = { nav, scope, ctx, sort, buyerById, creditByBuyer, buyerPhone, vendorPhone, empty };
  const trend = !reorderRoute && (
    <TrendStrip
      key={viewKey}
      buckets={buckets}
      title={orderLevel ? "Sales over time" : "Value over time"}
      onPick={(b: TrendBucket) => nav.open({ ...state, range: "custom", start: b.from, end: b.to })}
    />
  );

  return (
    <div className="px-4 md:px-6 py-4 max-w-6xl">
      <div className="flex items-center gap-3">
        <h1 className="font-display flex-none" style={{ fontSize: 20, fontWeight: 600, color: palette.black }}>{reorderRoute ? "Reorder" : "Dashboard"}</h1>
        <FindBox index={findIndex} query={query} onQuery={(q) => { setQuery(q); setScanned(null); }} onPick={pickFound} onScan={() => setScanning(true)} placeholder="Find anything" />
      </div>

      {/* Date and channel: one scrolling row on a phone */}
      <div className="flex gap-1.5 mt-2.5 items-center overflow-x-auto no-scrollbar md:flex-wrap" style={{ opacity: state.view === "pending" ? 0.45 : 1 }}>
        {(["all", "today", "7d", "30d", "mtd", "custom"] as Range[]).map((r) => (
          <button key={r} type="button" onClick={() => nav.go({ ...state, range: r })} className="font-body uppercase" style={chipStyle(state.range === r)}>{RANGE_LABEL[r]}</button>
        ))}
        <span aria-hidden className="flex-none" style={{ width: 1, height: 16, background: "rgba(26,26,26,0.15)", margin: "0 3px" }} />
        {([null, "exhibition", "in_store", "portal_self_service"] as (Source | null)[]).map((s) => (
          <button key={s ?? "all"} type="button" onClick={() => nav.go({ ...state, source: s })} className="font-body uppercase" style={{ ...chipStyle(state.source === s), background: state.source === s ? palette.ivoryDeep : "transparent", color: palette.softBlack, border: `1px solid ${state.source === s ? palette.gold : "rgba(26,26,26,0.18)"}` }}>
            {s ? SOURCE_LABEL[s] : "All Channels"}
          </button>
        ))}
      </div>

      {state.range === "custom" && <div className="mt-2" style={{ opacity: state.view === "pending" ? 0.45 : 1 }}><CustomRange nav={nav} /></div>}

      <div ref={resultsRef} tabIndex={-1} className="scroll-mt-[86px] md:scroll-mt-1" style={{ outline: "none" }} />
      <p role="status" className="sr-only">{lastFilter ? `Showing ${labelOf(lastFilter)}, ${countText}` : `Showing everything, ${countText}`}</p>
      {(state.filters.length > 0 || state.source) && <FilterBar nav={nav} labelOf={labelOf} />}

      {lastFilter && (
        <div className="mt-1">
          <EntityHeader
            nav={nav} filter={lastFilter} label={labelOf(lastFilter)} ctx={ctx} orders={orders} buyerById={buyerById}
            creditByBuyer={creditByBuyer} buyerPhone={buyerPhone} profileByKey={profileByKey}
            image={ctx.designs.get(lastFilter.value)?.image ?? flat.find((l) => l.design === lastFilter.value)?.item.image_url ?? null}
            startOpen={!!scanned}
          />
        </div>
      )}

      {/* Money. The Reorder task page leaves this to the laptop. */}
      <div className={`${reorderRoute ? "hidden md:grid" : "grid"} grid-cols-2 ${orderLevel ? "md:grid-cols-3 lg:grid-cols-6" : "md:grid-cols-3"} gap-2 mt-2.5`}>
        {orderLevel ? (
          <>
            <Tile phone accent label="Sales" value={formatINR(summary.amount)} {...tile(toView("orders", "total"))} />
            <Tile phone label={balanceLabel} value={formatINR(summary.balance)} sub={summary.overpaid > 0 ? `${formatINR(summary.overpaid)} overpaid` : undefined} {...tile(balanceTarget)} />
            <Tile label="Orders" value={String(summary.orders)} {...tile(toView("orders"))} />
            <Tile label="Pieces" value={String(summary.pieces)} sub={returnedText} {...tile(piecesTarget)} />
            <Tile label={customerAlone ? "Paid" : "Advance In"} value={formatINR(summary.advance)} sub={creditSub} {...tile(advanceTarget)} />
            {state.filters.length === 0 && <Tile external label="Credit Outstanding" value={formatINR(creditOutstanding)} href={nav.onward("/admin/credit-notes")} />}
          </>
        ) : (
          <>
            <Tile phone accent label="Value" value={formatINR(summary.amount)} sub="before discount and GST" {...tile(toView("orders"))} />
            <Tile phone label="Pieces" value={String(summary.pieces)} sub={returnedText} {...tile(piecesTarget)} />
            <Tile label="Orders with these items" value={String(summary.orders)} {...tile(toView("orders"))} />
          </>
        )}
      </div>
      <div className={`${reorderRoute ? "hidden" : ""} md:hidden font-body mt-1.5`} style={{ fontSize: 11, color: palette.softBlack }}>
        <p>
          {orderLevel ? countText : `${plural(summary.orders, "order")} with these items`}
          {orderLevel && returnedText ? ` · ${summary.returned} returned` : ""}
        </p>
        {orderLevel && (
          <p className="mt-0.5">
            {customerAlone ? "Paid" : "Advance in"} {formatINR(summary.advance)}{creditSub ? `, ${creditSub}` : ""}
            {state.filters.length === 0 && (
              <>
                {" · "}
                <Link href={nav.onward("/admin/credit-notes")} prefetch={false} style={{ borderBottom: `1px dotted ${palette.gold}` }}>Credit outstanding {formatINR(creditOutstanding)}</Link>
              </>
            )}
          </p>
        )}
      </div>
      {state.filters.length > 0 && (stock || pendingPieces > 0) && (
        <p className="font-body mt-1" style={{ fontSize: 11, color: palette.softBlack }}>
          <span style={{ color: palette.mutedGreige }}>Right now: </span>
          {stock && `${stock.onHand} in stock${stock.owed ? `, ${stock.owed} owed` : ""}`}
          {stock && pendingPieces > 0 && " · "}
          {pendingPieces > 0 && (
            <DrillLink href={nav.hrefFor(toView("pending"))} onGo={() => nav.open(toView("pending"))} style={{ borderBottom: `1px dotted ${palette.gold}` }}>{pendingPieces} pc pending</DrillLink>
          )}
        </p>
      )}

      <div className="hidden md:block">{trend}</div>

      {/* Views */}
      <div ref={tabsRef} className="flex gap-1.5 overflow-x-auto no-scrollbar mt-4" style={{ position: "relative" }}>
        {views.map((v) => {
          const next = toView(v);
          const on = state.view === v;
          const label = v === "pending" && pendingPieces > 0 ? `Pending · ${pendingPieces}` : VIEW_LABEL[v];
          return (
            <DrillLink key={v} href={nav.hrefFor(next)} onGo={() => nav.go(next)} current={on} className="font-body uppercase whitespace-nowrap" style={{ fontSize: 10, letterSpacing: "0.15em", padding: "8px 14px", background: on ? palette.black : "transparent", color: on ? palette.ivory : palette.softBlack, border: on ? "none" : "1px solid rgba(26,26,26,0.18)" }}>
              {label}
            </DrillLink>
          );
        })}
      </div>

      <div className="mt-3" style={{ opacity: nav.busy ? 0.6 : 1 }}>
        {state.view === "products" && <ProductsView {...viewProps} key={viewKey} />}
        {state.view === "vendors" && <VendorsView {...viewProps} key={viewKey} />}
        {state.view === "customers" && <CustomersView {...viewProps} key={viewKey} />}
        {state.view === "orders" && <OrdersView {...viewProps} key={viewKey} />}
        {state.view === "category" && <CategoryView {...viewProps} key={viewKey} />}
        {state.view === "events" && <EventsView {...viewProps} key={viewKey} />}
        {state.view === "reorder" && <ReorderView {...viewProps} key={viewKey} query={query} highlightKey={scanned} vendorChips={vendorList} />}
        {state.view === "pending" && (
          <PendingView
            nav={nav} rows={pending} ctx={ctx}
            vendorContact={(key) => ({ phone: profileByKey(key)?.phone ?? null, whatsapp: profileByKey(key)?.whatsapp ?? null })}
            empty={<p className="font-body mt-4" style={{ fontSize: 12, color: palette.mutedGreige }}>Nothing pending — every open line is confirmed or billed.</p>}
          />
        )}
      </div>

      <div className="md:hidden">{trend}</div>

      {state.view !== "reorder" && state.view !== "pending" && (
        <div className="font-body mt-3" style={{ fontSize: 10, color: palette.mutedGreige }}>
          {orderLevel && Math.round(adjustment) !== 0 && (state.view === "products" || state.view === "vendors" || state.view === "category") && (
            <p>Items {formatINR(summary.lineValue)}, discount and GST {adjustment < 0 ? `−${formatINR(-adjustment)}` : `+${formatINR(adjustment)}`}, Sales {formatINR(summary.amount)}.</p>
          )}
          <p>
            Pieces are real pieces, even on split bills. Value is price times quantity, before discount and GST.
            Sales and Value are before returns. Cancelled orders and retail bills are not counted.
            {!orderLevel && " One order can appear under several rows."}
            {state.view === "vendors" && " A vendor here is whoever last supplied the product."}
          </p>
          {orderLevel && (state.view === "customers" || state.view === "orders") && (
            <p className="mt-1">
              Balance is what each order still owes, after payments and credit applied.
              {state.view === "customers" && " Credit is a live wallet balance and ignores the dates, so a customer holding credit with no order in this period still appears."}
            </p>
          )}
        </div>
      )}
      {state.view === "reorder" && (
        <p className="font-body mt-3" style={{ fontSize: 10, color: palette.mutedGreige }}>
          Sold is wholesale pieces {periodPhrase(state)}, after returns. Retail bills are not counted. In Stock is after confirmed orders, so it can differ from the shelf.
        </p>
      )}

      {scanning && <QrScanner title="Scan a tag" onScan={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}

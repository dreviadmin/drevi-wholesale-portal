"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, ImageOff, Phone } from "lucide-react";
import { ZoomImage } from "@/components/Lightbox";
import type { SortAccessor } from "@/components/sortable";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { fmtDay, fmtDayYear } from "@/lib/dashboard/dates";
import { NONE, hasDim, addFilter, removeFilter, withFilter, type Filter, type SortState } from "@/lib/dashboard/state";
import {
  rollCategories, rollCustomers, rollEvents, rollOrders, rollProducts, rollReorder, rollVendors, unsoldDesigns,
  type CustomerRow, type DashContext, type EventRow, type GroupRow, type OrderRow, type ProductRow, type ReorderRow, type Scope,
} from "@/lib/dashboard/rollup";
import { designOf, plural, type DashBuyer } from "@/lib/dashboard/lines";
import { DrillLink, DrillTable, type Column } from "./DrillTable";
import type { Nav } from "./useDashState";

export interface ViewProps {
  nav: Nav;
  scope: Scope;
  ctx: DashContext;
  sort: SortState;
  buyerById: Map<string, DashBuyer>;
  creditByBuyer: Record<string, number>;
  buyerPhone: (id: string) => string | null;
  vendorPhone: (key: string) => string | null;
  empty: React.ReactNode;
}

const NAME_STYLE: React.CSSProperties = { fontSize: 13, fontWeight: 500, borderBottom: `1px solid ${palette.gold}` };
const SUB_STYLE: React.CSSProperties = { fontSize: 9, color: palette.mutedGreige };
const muted = (v: React.ReactNode) => <span style={{ color: palette.mutedGreige }}>{v}</span>;
const day = (ymd: string | null | undefined) => (ymd ? fmtDay(ymd) : "—");
const money = (v: number) => formatINR(v);
const SOURCE_LABEL: Record<string, string> = { exhibition: "Exhibition", in_store: "In-store", portal_self_service: "Portal" };
const statusLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
const stockText = (s: { onHand: number; owed: number }) => `${s.onHand}${s.owed ? ` (${s.owed} owed)` : ""}`;

/** Narrows the page to one thing. `fresh` starts over on it instead of adding to the filters. */
export function FilterLink({ nav, filter, fresh, primary, children, label, className, style }: {
  nav: Nav;
  filter: Filter;
  fresh?: boolean;
  primary?: boolean;
  children: React.ReactNode;
  label: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const next = withFilter(nav.state, filter, fresh);
  return (
    <DrillLink href={nav.hrefFor(next)} onGo={() => nav.open(next)} primary={primary} label={label} className={className ?? "font-display"} style={style ?? NAME_STYLE}>
      {children}
    </DrillLink>
  );
}

export function Thumb({ src, alt, width = 36, height = 45 }: { src: string | null; alt: string; width?: number; height?: number }) {
  return src
    ? <ZoomImage src={src} alt={alt} width={width} height={height} />
    : <div className="flex items-center justify-center flex-none" style={{ width, height, background: palette.ivoryDeep }}><ImageOff size={13} color={palette.mutedGreige} /></div>;
}

export function CallLink({ phone, name }: { phone: string | null; name: string }) {
  if (!phone) return null;
  return (
    <a href={`tel:${phone}`} aria-label={`Call ${name}`} className="inline-flex items-center justify-center flex-none" style={{ width: 28, height: 28, border: `1px solid ${palette.gold}`, borderRadius: 999 }}>
      <Phone size={12} color={palette.goldDeep} strokeWidth={1.8} />
    </a>
  );
}

const PRODUCT_ACC: Record<string, SortAccessor<ProductRow>> = {
  product: (r) => r.title, pieces: (r) => r.pieces, value: (r) => r.value, orders: (r) => r.orderIds.size,
  customers: (r) => r.customerIds.size, returned: (r) => r.returned, stock: (r) => r.stock, last: (r) => r.last,
};

export function ProductsView({ nav, scope, ctx, sort, empty }: ViewProps) {
  const { state } = nav;
  const sold = useMemo(() => rollProducts(scope, ctx), [scope, ctx]);
  const unsold = useMemo(() => unsoldDesigns(state.filters, sold, ctx), [state.filters, sold, ctx]);
  const [showUnsold, setShowUnsold] = useState(false);
  const rows = useMemo(() => (showUnsold ? [...sold, ...unsold] : sold), [showUnsold, sold, unsold]);
  const anyReturned = sold.some((r) => r.returned > 0);

  const open = (r: ProductRow, primary: boolean, children: React.ReactNode) => (
    <FilterLink nav={nav} filter={{ dim: "design", value: r.key }} primary={primary} label={`Open ${r.title}`}>{children}</FilterLink>
  );
  const columns: Column<ProductRow>[] = [
    { key: "thumb", label: "", width: 44, render: (r) => <Thumb src={r.image} alt={r.title} /> },
    { key: "product", label: "Product", render: (r) => <>{open(r, true, r.title)}<br /><span style={{ ...SUB_STYLE, letterSpacing: "0.06em" }}>{r.label}</span></>, csv: (r) => r.title },
    { key: "pieces", label: "Pieces", right: true, bold: true, render: (r) => r.pieces, csv: (r) => r.pieces },
    ...(anyReturned ? [{ key: "returned", label: "Returned", right: true, render: (r: ProductRow) => r.returned || "—", csv: (r: ProductRow) => r.returned }] : []),
    { key: "value", label: "Value", right: true, render: (r) => money(r.value), csv: (r) => r.value },
    { key: "orders", label: "Orders", right: true, render: (r) => r.orderIds.size, csv: (r) => r.orderIds.size },
    { key: "customers", label: "Customers", right: true, render: (r) => r.customerIds.size, csv: (r) => r.customerIds.size },
    { key: "stock", label: "In Stock", right: true, defaultDir: "asc", render: (r) => r.stock ?? "—", csv: (r) => r.stock },
    { key: "last", label: "Last Sold", right: true, render: (r) => (r.last ? fmtDay(r.last) : muted("No sale")), csv: (r) => r.last },
  ];

  return (
    <>
      {rows.length === 0 ? empty : (
        <DrillTable
          rows={rows} columns={columns} accessors={PRODUCT_ACC} sort={sort} onSort={(s) => nav.go({ ...state, sort: s })} rowKey={(r) => r.key} csvName="dashboard-products"
          phone={(r) => ({
            image: <Thumb src={r.image} alt={r.title} width={32} height={40} />,
            title: open(r, true, r.title),
            sub: [plural(r.orderIds.size, "order"), r.stock == null ? null : `${r.stock} in stock`].filter(Boolean).join(" · "),
            value: r.pieces, valueLabel: "Pieces",
          })}
        />
      )}
      {unsold.length > 0 && (
        <button type="button" onClick={() => setShowUnsold((v) => !v)} className="font-body mt-3" style={{ fontSize: 11.5, color: palette.goldDeep, textDecoration: "underline" }}>
          {showUnsold ? "Hide" : "Show"} {plural(unsold.length, "product")} with no sale in this period
        </button>
      )}
    </>
  );
}

const GROUP_ACC = (nameKey: string): Record<string, SortAccessor<GroupRow>> => ({
  [nameKey]: (r) => r.name, designs: (r) => r.designs.size, pieces: (r) => r.pieces, value: (r) => r.value,
  orders: (r) => r.orderIds.size, customers: (r) => r.customerIds.size, stock: (r) => r.stock.onHand,
});
const VENDOR_ACC = GROUP_ACC("vendor");
const CATEGORY_ACC = GROUP_ACC("category");

export function VendorsView({ nav, scope, ctx, sort, vendorPhone, empty }: ViewProps) {
  const rows = useMemo(() => rollVendors(scope, ctx, nav.state.filters), [scope, ctx, nav.state.filters]);
  if (!rows.length) return <>{empty}</>;
  const open = (r: GroupRow) => <FilterLink nav={nav} filter={{ dim: "vendor", value: r.key }} primary label={`Open vendor ${r.name}`}>{r.name}</FilterLink>;
  const columns: Column<GroupRow>[] = [
    { key: "vendor", label: "Vendor", render: open, csv: (r) => r.name },
    { key: "designs", label: "Products Sold", right: true, render: (r) => r.designs.size, csv: (r) => r.designs.size },
    { key: "pieces", label: "Pieces", right: true, bold: true, render: (r) => r.pieces, csv: (r) => r.pieces },
    { key: "value", label: "Value", right: true, render: (r) => money(r.value), csv: (r) => r.value },
    { key: "orders", label: "Orders", right: true, render: (r) => r.orderIds.size, csv: (r) => r.orderIds.size },
    { key: "customers", label: "Customers", right: true, render: (r) => r.customerIds.size, csv: (r) => r.customerIds.size },
    { key: "stock", label: "In Stock", right: true, defaultDir: "asc", render: (r) => stockText(r.stock), csv: (r) => r.stock.onHand },
  ];
  return (
    <DrillTable
      rows={rows} columns={columns} accessors={VENDOR_ACC} sort={sort} onSort={(s) => nav.go({ ...nav.state, sort: s })} rowKey={(r) => r.key} csvName="dashboard-vendors"
      phone={(r) => ({
        title: open(r), sub: `${plural(r.designs.size, "product")} · ${plural(r.pieces, "piece")}`, value: money(r.value), valueLabel: "Value",
        action: r.key === NONE ? undefined : <CallLink phone={vendorPhone(r.key)} name={r.name} />,
      })}
    />
  );
}

export function CategoryView({ nav, scope, ctx, sort, empty }: ViewProps) {
  const rows = useMemo(() => rollCategories(scope, ctx, nav.state.filters), [scope, ctx, nav.state.filters]);
  if (!rows.length) return <>{empty}</>;
  const open = (r: GroupRow) => <FilterLink nav={nav} filter={{ dim: "category", value: r.key }} primary label={`Open category ${r.name}`}>{r.name}</FilterLink>;
  const columns: Column<GroupRow>[] = [
    { key: "category", label: "Category", render: open, csv: (r) => r.name },
    { key: "designs", label: "Products Sold", right: true, render: (r) => r.designs.size, csv: (r) => r.designs.size },
    { key: "pieces", label: "Pieces", right: true, bold: true, render: (r) => r.pieces, csv: (r) => r.pieces },
    { key: "value", label: "Value", right: true, render: (r) => money(r.value), csv: (r) => r.value },
    { key: "orders", label: "Orders", right: true, render: (r) => r.orderIds.size, csv: (r) => r.orderIds.size },
    { key: "stock", label: "In Stock", right: true, defaultDir: "asc", render: (r) => stockText(r.stock), csv: (r) => r.stock.onHand },
  ];
  return (
    <DrillTable
      rows={rows} columns={columns} accessors={CATEGORY_ACC} sort={sort} onSort={(s) => nav.go({ ...nav.state, sort: s })} rowKey={(r) => r.key} csvName="dashboard-categories"
      phone={(r) => ({ title: open(r), sub: `${plural(r.designs.size, "product")} · ${plural(r.pieces, "piece")}`, value: money(r.value), valueLabel: "Value" })}
    />
  );
}

const CUSTOMER_ACC: Record<string, SortAccessor<CustomerRow>> = {
  customer: (r) => r.name, orders: (r) => r.orders, pieces: (r) => r.pieces, total: (r) => r.total, advance: (r) => r.advance,
  credit: (r) => r.credit, balance: (r) => r.balance, value: (r) => r.value, last: (r) => r.last, oldest: (r) => r.oldest,
};

/** A negative wallet means more was spent than granted: never a quiet minus. */
export function creditCell(credit: number) {
  if (credit < 0) return <span style={{ color: palette.crimsonText, fontWeight: 600 }}>OVERDRAWN {formatINR(Math.abs(credit))}</span>;
  return credit > 0 ? <span style={{ color: palette.goldDeep }}>{formatINR(credit)}</span> : muted("—");
}

export function CustomersView({ nav, scope, sort, buyerById, creditByBuyer, buyerPhone, empty }: ViewProps) {
  const { state } = nav;
  const rows = useMemo(
    () => rollCustomers(scope, buyerById, creditByBuyer, { includeCreditOnly: state.filters.length === 0 }),
    [scope, buyerById, creditByBuyer, state.filters.length],
  );
  if (!rows.length) return <>{empty}</>;
  const open = (r: CustomerRow) => <FilterLink nav={nav} filter={{ dim: "customer", value: r.id }} primary label={`Open customer ${r.name}`}>{r.name}</FilterLink>;
  const contact = (r: CustomerRow) => [r.buyer?.owner_name, r.buyer?.city, r.buyer?.phone].filter(Boolean).join(" · ");
  const who: Column<CustomerRow> = { key: "customer", label: "Customer", render: (r) => <>{open(r)}<br /><span style={SUB_STYLE}>{contact(r)}</span></>, csv: (r) => r.name };
  const lastCol: Column<CustomerRow> = { key: "last", label: "Last Order", right: true, render: (r) => day(r.last), csv: (r) => r.last };
  const columns: Column<CustomerRow>[] = scope.orderLevel ? [
    who,
    { key: "orders", label: "Orders", right: true, render: (r) => r.orders, csv: (r) => r.orders },
    { key: "pieces", label: "Pieces", right: true, render: (r) => r.pieces, csv: (r) => r.pieces },
    { key: "total", label: "Total", right: true, bold: true, render: (r) => money(r.total), csv: (r) => r.total },
    { key: "advance", label: "Advance", right: true, render: (r) => money(r.advance), csv: (r) => r.advance },
    { key: "credit", label: "Credit", right: true, render: (r) => creditCell(r.credit), csv: (r) => r.credit },
    { key: "balance", label: "Balance", right: true, render: (r) => <span style={{ color: r.balance > 0 ? palette.crimsonText : palette.mutedGreige }}>{money(r.balance)}</span>, csv: (r) => r.balance },
    lastCol,
    { key: "oldest", label: "Oldest Unpaid", right: true, defaultDir: "asc", render: (r) => day(r.oldest), csv: (r) => r.oldest },
  ] : [
    who,
    { key: "orders", label: "Orders", right: true, render: (r) => r.orders, csv: (r) => r.orders },
    { key: "pieces", label: "Pieces", right: true, render: (r) => r.pieces, csv: (r) => r.pieces },
    { key: "value", label: "Value", right: true, bold: true, render: (r) => money(r.value), csv: (r) => r.value },
    lastCol,
  ];
  return (
    <DrillTable
      rows={rows} columns={columns} accessors={CUSTOMER_ACC} sort={sort} onSort={(s) => nav.go({ ...state, sort: s })} rowKey={(r) => r.id} csvName="dashboard-customers"
      phone={(r) => ({
        title: open(r),
        sub: <>{plural(r.orders, "order")}{r.last ? ` · last ${fmtDay(r.last)}` : ""}{r.credit !== 0 && <> · {creditCell(r.credit)} {r.credit > 0 ? "credit" : ""}</>}</>,
        value: money(scope.orderLevel ? r.total : r.value), valueLabel: scope.orderLevel ? "Total" : "Value",
        action: <CallLink phone={buyerPhone(r.id)} name={r.name} />,
      })}
    />
  );
}

const ORDER_ACC: Record<string, SortAccessor<OrderRow>> = {
  order: (r) => r.order.order_number, date: (r) => r.order.submitted_at, customer: (r) => r.name, pieces: (r) => r.pieces,
  total: (r) => r.total, value: (r) => r.value, balance: (r) => r.balance, status: (r) => r.order.status, source: (r) => r.order.source,
};

export function OrdersView({ nav, scope, sort, buyerById, empty }: ViewProps) {
  const { state } = nav;
  const rows = useMemo(() => rollOrders(scope, buyerById), [scope, buyerById]);
  if (!rows.length) return <>{empty}</>;
  const link = (r: OrderRow) => (
    <Link href={nav.onward(`/admin/orders/${r.order.id}`)} prefetch={false} data-primary="" className="font-display" style={NAME_STYLE}>{r.order.order_number}</Link>
  );
  const who = (r: OrderRow) => (hasDim(state.filters, "customer") ? r.name : (
    <FilterLink nav={nav} filter={{ dim: "customer", value: r.order.buyer_id }} label={`Open customer ${r.name}`} className="font-body" style={{ borderBottom: `1px dotted ${palette.gold}` }}>{r.name}</FilterLink>
  ));
  const base: Column<OrderRow>[] = [
    { key: "order", label: "Order", render: link, csv: (r) => r.order.order_number },
    { key: "date", label: "Date", render: (r) => fmtDayYear(r.day), csv: (r) => r.day, defaultDir: "desc" },
    { key: "customer", label: "Customer", render: who, csv: (r) => r.name },
    { key: "pieces", label: "Pieces", right: true, render: (r) => r.pieces, csv: (r) => r.pieces },
  ];
  const tail: Column<OrderRow>[] = [
    { key: "status", label: "Status", render: (r) => statusLabel(r.order.status), csv: (r) => r.order.status },
    { key: "source", label: "Channel", render: (r) => SOURCE_LABEL[r.order.source] ?? r.order.source, csv: (r) => r.order.source },
  ];
  const columns: Column<OrderRow>[] = scope.orderLevel ? [
    ...base,
    { key: "total", label: "Total", right: true, bold: true, render: (r) => money(r.total), csv: (r) => r.total },
    { key: "balance", label: "Balance", right: true, render: (r) => <span style={{ color: r.balance > 0 ? palette.crimsonText : palette.mutedGreige }}>{money(r.balance)}</span>, csv: (r) => r.balance },
    ...tail,
  ] : [
    ...base,
    { key: "value", label: "These Items", right: true, bold: true, render: (r) => money(r.value), csv: (r) => r.value },
    { key: "total", label: "Order Total", right: true, render: (r) => money(r.total), csv: (r) => r.total },
    ...tail,
  ];
  return (
    <DrillTable
      rows={rows} columns={columns} accessors={ORDER_ACC} sort={sort} onSort={(s) => nav.go({ ...state, sort: s })} rowKey={(r) => r.order.id} csvName="dashboard-orders"
      phone={(r) => ({
        title: link(r),
        sub: `${r.name} · ${fmtDay(r.day)}`,
        value: money(scope.orderLevel ? r.total : r.value),
        valueLabel: scope.orderLevel ? "Total" : `of ${money(r.total)}`,
      })}
    />
  );
}

const EVENT_ACC: Record<string, SortAccessor<EventRow>> = {
  event: (r) => r.event, orders: (r) => r.orders, customers: (r) => r.customers, pieces: (r) => r.pieces, total: (r) => r.total,
  value: (r) => r.value, balance: (r) => r.balance,
};

export function EventsView({ nav, scope, sort, empty }: ViewProps) {
  const rows = useMemo(() => rollEvents(scope), [scope]);
  if (!rows.length) return <>{empty}</>;
  const open = (r: EventRow) => <FilterLink nav={nav} filter={{ dim: "event", value: r.event }} primary label={`Open exhibition ${r.event}`}>{r.event}</FilterLink>;
  const columns: Column<EventRow>[] = [
    { key: "event", label: "Exhibition", render: open, csv: (r) => r.event },
    { key: "orders", label: "Orders", right: true, render: (r) => r.orders, csv: (r) => r.orders },
    { key: "customers", label: "Customers", right: true, render: (r) => r.customers, csv: (r) => r.customers },
    { key: "pieces", label: "Pieces", right: true, render: (r) => r.pieces, csv: (r) => r.pieces },
    ...(scope.orderLevel ? [
      { key: "total", label: "Total", right: true, bold: true, render: (r: EventRow) => money(r.total), csv: (r: EventRow) => r.total },
      { key: "balance", label: "Balance", right: true, render: (r: EventRow) => money(r.balance), csv: (r: EventRow) => r.balance },
    ] : [
      { key: "value", label: "Value", right: true, bold: true, render: (r: EventRow) => money(r.value), csv: (r: EventRow) => r.value },
    ]),
  ];
  return (
    <DrillTable
      rows={rows} columns={columns} accessors={EVENT_ACC} sort={sort} onSort={(s) => nav.go({ ...nav.state, sort: s })} rowKey={(r) => r.event} csvName="dashboard-exhibitions"
      phone={(r) => ({ title: open(r), sub: `${plural(r.orders, "order")} · ${plural(r.customers, "customer")}`, value: money(scope.orderLevel ? r.total : r.value), valueLabel: scope.orderLevel ? "Total" : "Value" })}
    />
  );
}

const REORDER_ACC: Record<string, SortAccessor<ReorderRow>> = {
  product: (r) => r.p.title ?? r.p.sku,
  vendor: (r) => r.vendor?.name,
  vendorSku: (r) => r.vendorSku,
  cost: (r) => (r.info && r.info.last_cost > 0 ? r.info.last_cost : null),
  grCost: (r) => r.gr?.cost ?? null,
  grDate: (r) => r.gr?.date ?? null,
  sold: (r) => r.sold,
  stock: (r) => r.p.current_qty,
};

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { if (await copyText(code)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
      className="inline-flex items-center gap-1.5 font-body"
      style={{ fontSize: 12, color: palette.black, background: "none", border: "none", padding: 0, cursor: "pointer" }}
      aria-label={`Copy vendor SKU ${code}`}
    >
      <span style={{ borderBottom: "1px dotted rgba(26,26,26,0.35)" }}>{code}</span>
      {copied ? <Check size={12} color={palette.goldDeep} /> : <Copy size={12} color={palette.mutedGreige} />}
    </button>
  );
}

export function ReorderView({ nav, scope, ctx, sort, vendorPhone, empty, query, highlightKey, vendorChips }: ViewProps & {
  query: string;
  highlightKey: string | null;
  vendorChips: { key: string; name: string }[];
}) {
  const { state } = nav;
  const rows = useMemo(
    () => rollReorder(scope, ctx, { filters: state.filters, query, stock: state.stock }),
    [scope, ctx, state.filters, query, state.stock],
  );
  const vendorKey = state.filters.find((f) => f.dim === "vendor")?.value ?? null;

  // Already on this product, the name has nowhere left to go.
  const productName = (r: ReorderRow) => (hasDim(state.filters, "design")
    ? <span className="font-display" style={{ fontSize: 13, fontWeight: 500 }}>{r.p.title ?? r.p.sku}</span>
    : <FilterLink nav={nav} filter={{ dim: "design", value: designOf(r.key) }} label={`Open ${r.p.title ?? r.p.sku}`}>{r.p.title ?? r.p.sku}</FilterLink>);

  const columns: Column<ReorderRow>[] = [
    { key: "thumb", label: "", width: 44, render: (r) => <Thumb src={r.p.image_urls?.[0] ?? null} alt={r.p.title ?? r.p.sku} /> },
    {
      key: "product", label: "Product and Size",
      render: (r) => (
        <>
          {productName(r)}
          <br /><span style={{ ...SUB_STYLE, letterSpacing: "0.06em" }}>{r.p.sku}</span>
          {r.discontinued && <span className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.1em", color: palette.crimsonText, marginLeft: 6 }}>Discontinued</span>}
        </>
      ),
      csv: (r) => r.p.sku,
    },
    { key: "sold", label: "Sold", right: true, render: (r) => (r.sold > 0 ? <span style={{ color: palette.goldDeep, fontWeight: 600 }}>{r.sold}</span> : "0"), csv: (r) => r.sold },
    { key: "stock", label: "In Stock", right: true, defaultDir: "asc", render: (r) => <span style={{ color: r.p.current_qty <= 0 ? palette.crimsonText : undefined }}>{r.p.current_qty}</span>, csv: (r) => r.p.current_qty },
    {
      key: "vendor", label: "Vendor",
      render: (r) => (r.vendor
        ? <FilterLink nav={nav} filter={{ dim: "vendor", value: r.vendor.key }} label={`Open vendor ${r.vendor.name}`} className="font-body" style={{ borderBottom: `1px dotted ${palette.gold}` }}>{r.vendor.name}</FilterLink>
        : muted("—")),
      csv: (r) => r.vendor?.name,
    },
    { key: "vendorSku", label: "Vendor SKU", render: (r) => (r.vendorSku ? <CopyCode code={r.vendorSku} /> : muted("—")), csv: (r) => r.vendorSku },
    { key: "cost", label: "Sheet Cost", right: true, render: (r) => <span title="from sheet">{r.info && r.info.last_cost > 0 ? formatINR(r.info.last_cost) : "—"}</span>, csv: (r) => r.info?.last_cost },
    { key: "grCost", label: "Last Bought", right: true, render: (r) => <span title="from deliveries" style={{ color: r.gr && r.gr.cost > 0 ? palette.goldDeep : palette.mutedGreige }}>{r.gr && r.gr.cost > 0 ? formatINR(r.gr.cost) : "—"}</span>, csv: (r) => r.gr?.cost },
    { key: "grDate", label: "Bought On", defaultDir: "desc", render: (r) => <span title="from deliveries" style={{ color: palette.mutedGreige, fontSize: 11 }}>{r.gr ? fmtDay(r.gr.date) : "—"}</span>, csv: (r) => r.gr?.date },
  ];

  const chip = (active: boolean) => ({ fontSize: 10.5, padding: "5px 11px", background: active ? palette.ivoryDeep : "transparent", color: palette.softBlack, border: `1px solid ${active ? palette.gold : "rgba(26,26,26,0.15)"}` });
  return (
    <>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
        {([[null, "All stock"], ["low", "Low stock"], ["out", "Sold out"]] as const).map(([stock, label]) => (
          <button key={label} type="button" onClick={() => nav.go({ ...state, stock })} className="font-body whitespace-nowrap" style={chip(state.stock === stock)}>{label}</button>
        ))}
      </div>
      {!hasDim(state.filters, "design") && (
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar mt-1.5">
          <button type="button" onClick={() => nav.open({ ...state, filters: removeFilter(state.filters, "vendor") }, { scroll: false })} className="font-body whitespace-nowrap" style={chip(!vendorKey)}>All vendors</button>
          {vendorChips.map((v) => (
            <button key={v.key} type="button" onClick={() => nav.open({ ...state, filters: addFilter(state.filters, { dim: "vendor", value: v.key }) }, { scroll: false })} className="font-body whitespace-nowrap" style={chip(vendorKey === v.key)}>{v.name}</button>
          ))}
        </div>
      )}
      <div className="mt-3">
        {rows.length === 0 ? empty : (
          <DrillTable
            rows={rows} columns={columns} accessors={REORDER_ACC} sort={sort} onSort={(s) => nav.go({ ...state, sort: s })} rowKey={(r) => r.p.sku} csvName="dashboard-reorder" tappable={false}
            highlight={(r) => r.key === highlightKey}
            phone={(r) => ({
              image: <Thumb src={r.p.image_urls?.[0] ?? null} alt={r.p.title ?? r.p.sku} width={32} height={40} />,
              title: productName(r),
              sub: [`${r.p.current_qty} in stock`, r.variant, r.vendor?.name, r.gr && r.gr.cost > 0 ? `cost ${formatINR(r.gr.cost)}` : null, r.discontinued ? "Discontinued" : null].filter(Boolean).join(" · "),
              extra: r.vendorSku ? <CopyCode code={r.vendorSku} /> : undefined,
              value: r.p.current_qty, valueLabel: "In Stock",
              action: r.vendor ? <CallLink phone={vendorPhone(r.vendor.key)} name={r.vendor.name} /> : undefined,
            })}
          />
        )}
      </div>
    </>
  );
}

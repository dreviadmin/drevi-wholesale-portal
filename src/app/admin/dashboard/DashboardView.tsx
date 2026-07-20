"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, X, ScanLine, Copy, Check, ImageOff } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { ZoomImage } from "@/components/Lightbox";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { OrderItem, OrderStatus } from "@/lib/types";

export interface DashOrder {
  id: string;
  order_number: string;
  status: OrderStatus;
  source: string;
  total_amount: number;
  advance_amount: number | null;
  submitted_at: string;
  buyer_id: string;
  items: OrderItem[];
}
export interface DashBuyer {
  id: string;
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
}
export interface DashProduct {
  sku: string;
  title: string | null;
  image_urls: string[] | null;
  current_qty: number;
  wholesale_price: number;
  category: string | null;
  restockable: boolean;
  wholesale_visible: boolean;
}
export interface VendorInfo {
  sku: string;
  vendor_name: string | null;
  vendor_id: string | null;
  vendor_sku: string | null;
  last_cost: number;
  last_receipt_date: string | null;
}

type Tab = "products" | "vendors" | "customers" | "reorder";
type Range = "today" | "7d" | "all";

// Row shapes for the four tables (also used by their sort accessors).
interface ProductRow { sku: string; title: string; image: string | null; pieces: number; value: number; orders: Set<string> }
interface VendorRow { vendor: string; skus: Set<string>; pieces: number; value: number }
interface CustomerRow { buyer: DashBuyer | null; id: string; orders: number; total: number; advance: number; pieces: number }
interface ReorderRow { p: DashProduct; v: VendorInfo | null; sold: number; gr: { cost: number; date: string } | null }

const PRODUCT_ACC: Record<string, SortAccessor<ProductRow>> = {
  product: (r) => r.title,
  pieces: (r) => r.pieces,
  value: (r) => r.value,
  orders: (r) => r.orders.size,
};
const VENDOR_ACC: Record<string, SortAccessor<VendorRow>> = {
  vendor: (r) => r.vendor,
  designs: (r) => r.skus.size,
  pieces: (r) => r.pieces,
  value: (r) => r.value,
};
const CUSTOMER_ACC: Record<string, SortAccessor<CustomerRow>> = {
  customer: (r) => r.buyer?.business_name,
  orders: (r) => r.orders,
  pieces: (r) => r.pieces,
  total: (r) => r.total,
  advance: (r) => r.advance,
  balance: (r) => Math.max(0, r.total - r.advance),
};
const REORDER_ACC: Record<string, SortAccessor<ReorderRow>> = {
  product: (r) => r.p.title ?? r.p.sku,
  vendor: (r) => r.v?.vendor_name,
  vendorSku: (r) => r.v?.vendor_sku,
  cost: (r) => (r.v && r.v.last_cost > 0 ? r.v.last_cost : null),
  grCost: (r) => r.gr?.cost ?? null,
  grDate: (r) => r.gr?.date ?? null,
  sold: (r) => r.sold,
  stock: (r) => r.p.current_qty,
};

// Real pieces sold: a GST bill-split inflates qty on paper; actual_qty keeps
// the truth. Line value stays qty × unit_price (that IS the money).
const piecesOf = (it: OrderItem) => it.actual_qty ?? it.qty;
const lineValue = (it: OrderItem) => it.qty * it.unit_price;

// Exhibition days run on India time — "today" must not flip at 5:30am.
function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

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

export function DashboardView({ orders, buyers, products, vendors, grBySku = {} }: {
  orders: DashOrder[];
  buyers: DashBuyer[];
  products: DashProduct[];
  vendors: VendorInfo[];
  // Latest goods-receipt cost/date per SKU — shown beside the sheet columns.
  grBySku?: Record<string, { cost: number; date: string }>;
}) {
  const [tab, setTab] = useState<Tab>("products");
  const [range, setRange] = useState<Range>("all");
  const [query, setQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState<string>("All");
  const [scanning, setScanning] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [highlightSku, setHighlightSku] = useState<string | null>(null);

  const buyerById = useMemo(() => new Map(buyers.map((b) => [b.id, b])), [buyers]);
  const productBySku = useMemo(() => new Map(products.map((p) => [p.sku.trim().toUpperCase(), p])), [products]);
  const vendorBySku = useMemo(() => new Map(vendors.map((v) => [v.sku.trim().toUpperCase(), v])), [vendors]);

  // Cancelled orders carry no money; they're excluded from every aggregate.
  const live = useMemo(() => {
    const todayIst = istDay(new Date().toISOString());
    const cutoff7 = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return orders.filter((o) => {
      if (o.status === "cancelled") return false;
      if (range === "today") return istDay(o.submitted_at) === todayIst;
      if (range === "7d") return new Date(o.submitted_at).getTime() >= cutoff7;
      return true;
    });
  }, [orders, range]);

  const tiles = useMemo(() => {
    const revenue = live.reduce((s, o) => s + (o.total_amount || 0), 0);
    const advance = live.reduce((s, o) => s + (o.advance_amount || 0), 0);
    const pieces = live.reduce((s, o) => s + (o.items ?? []).reduce((t, it) => t + piecesOf(it), 0), 0);
    return { orders: live.length, revenue, advance, balance: Math.max(0, revenue - advance), pieces };
  }, [live]);

  // ---- By product -----------------------------------------------------------
  const byProduct = useMemo(() => {
    const map = new Map<string, { sku: string; title: string; image: string | null; pieces: number; value: number; orders: Set<string> }>();
    for (const o of live) {
      for (const it of o.items ?? []) {
        const key = it.sku.trim().toUpperCase();
        const p = productBySku.get(key);
        const e = map.get(key) ?? {
          sku: it.sku,
          title: p?.title ?? it.title ?? it.sku,
          image: p?.image_urls?.[0] ?? it.image_url ?? null,
          pieces: 0, value: 0, orders: new Set<string>(),
        };
        e.pieces += piecesOf(it);
        e.value += lineValue(it);
        e.orders.add(o.id);
        map.set(key, e);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.pieces - a.pieces || b.value - a.value);
  }, [live, productBySku]);

  // ---- By vendor ------------------------------------------------------------
  const byVendor = useMemo(() => {
    const map = new Map<string, { vendor: string; skus: Set<string>; pieces: number; value: number }>();
    for (const row of byProduct) {
      const v = vendorBySku.get(row.sku.trim().toUpperCase());
      const name = v?.vendor_name?.trim() || "(no vendor in sheet)";
      const e = map.get(name) ?? { vendor: name, skus: new Set<string>(), pieces: 0, value: 0 };
      e.skus.add(row.sku);
      e.pieces += row.pieces;
      e.value += row.value;
      map.set(name, e);
    }
    return Array.from(map.values()).sort((a, b) => b.value - a.value);
  }, [byProduct, vendorBySku]);

  // ---- By customer ----------------------------------------------------------
  const byCustomer = useMemo(() => {
    const map = new Map<string, { buyer: DashBuyer | null; id: string; orders: number; total: number; advance: number; pieces: number }>();
    for (const o of live) {
      const e = map.get(o.buyer_id) ?? { buyer: buyerById.get(o.buyer_id) ?? null, id: o.buyer_id, orders: 0, total: 0, advance: 0, pieces: 0 };
      e.orders += 1;
      e.total += o.total_amount || 0;
      e.advance += o.advance_amount || 0;
      e.pieces += (o.items ?? []).reduce((t, it) => t + piecesOf(it), 0);
      map.set(o.buyer_id, e);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [live, buyerById]);

  // ---- Reorder table (Rakesh) ----------------------------------------------
  const soldBySku = useMemo(() => new Map(byProduct.map((r) => [r.sku.trim().toUpperCase(), r])), [byProduct]);
  const vendorNames = useMemo(() => {
    const names = new Set<string>();
    for (const v of vendors) if (v.vendor_name?.trim()) names.add(v.vendor_name.trim());
    return ["All", ...Array.from(names).sort()];
  }, [vendors]);

  const reorderRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => p.wholesale_visible)
      .map((p) => {
        const key = p.sku.trim().toUpperCase();
        return { p, v: vendorBySku.get(key) ?? null, sold: soldBySku.get(key)?.pieces ?? 0, gr: grBySku[key] ?? null };
      })
      .filter(({ p, v }) => {
        if (vendorFilter !== "All" && (v?.vendor_name?.trim() || "") !== vendorFilter) return false;
        if (!q) return true;
        return (
          p.sku.toLowerCase().includes(q) ||
          (p.title ?? "").toLowerCase().includes(q) ||
          (v?.vendor_name ?? "").toLowerCase().includes(q) ||
          (v?.vendor_sku ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.sold - a.sold || (a.p.title ?? a.p.sku).localeCompare(b.p.title ?? b.p.sku));
  }, [products, vendorBySku, soldBySku, query, vendorFilter, grBySku]);

  // Golden rule: every table sorts by its column headers.
  const prodSort = useSort(byProduct as ProductRow[], PRODUCT_ACC, { key: "pieces", dir: "desc" });
  const vendSort = useSort(byVendor as VendorRow[], VENDOR_ACC, { key: "value", dir: "desc" });
  const custSort = useSort(byCustomer as CustomerRow[], CUSTOMER_ACC, { key: "total", dir: "desc" });
  const reordSort = useSort(reorderRows as ReorderRow[], REORDER_ACC, { key: "sold", dir: "desc" });

  // Golden rule: every search has a scan. A hit jumps to Reorder filtered to it.
  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    const p = productBySku.get(sku);
    if (!p) return { ok: false, message: `${sku || "Empty scan"} — not on the portal` };
    setScanning(false);
    setTab("reorder");
    setQuery(p.sku);
    setVendorFilter("All");
    setHighlightSku(p.sku);
    const v = vendorBySku.get(sku);
    return { ok: true, message: v?.vendor_name ? `${p.title ?? p.sku} — ${v.vendor_name}` : p.title ?? p.sku };
  }

  async function doCopy(text: string, key: string) {
    const ok = await copyText(text);
    if (ok) { setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500); }
  }

  const th = (t: string, right = false) => (
    <th className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: palette.mutedGreige, textAlign: right ? "right" : "left", padding: "6px 8px", whiteSpace: "nowrap" }}>{t}</th>
  );
  const td = (content: React.ReactNode, right = false, bold = false) => (
    <td className={bold ? "font-display" : "font-body"} style={{ fontSize: bold ? 13 : 12, fontWeight: bold ? 600 : 400, color: palette.black, textAlign: right ? "right" : "left", padding: "8px", whiteSpace: "nowrap" }}>{content}</td>
  );

  const tabBtn = (t: Tab, label: string) => (
    <button
      key={t}
      type="button"
      onClick={() => setTab(t)}
      className="font-body uppercase whitespace-nowrap"
      style={{
        fontSize: 10, letterSpacing: "0.15em", padding: "8px 14px",
        background: tab === t ? palette.black : "transparent",
        color: tab === t ? palette.ivory : palette.softBlack,
        border: tab === t ? "none" : "1px solid rgba(26,26,26,0.18)",
      }}
    >
      {label}
    </button>
  );

  const tile = (label: string, value: string, accent = false) => (
    <div style={{ background: accent ? palette.black : palette.ivoryDeep, padding: "12px 14px", minWidth: 0 }}>
      <div className="font-body uppercase truncate" style={{ fontSize: 8, letterSpacing: "0.16em", color: accent ? palette.champagne ?? palette.gold : palette.mutedGreige }}>{label}</div>
      <div className="font-display truncate" style={{ fontSize: 19, fontWeight: 600, color: accent ? palette.ivory : palette.black, marginTop: 3 }}>{value}</div>
    </div>
  );

  return (
    <div className="px-4 md:px-6 py-5 max-w-6xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Dashboard</h1>

      {/* Range chips */}
      <div className="flex gap-1.5 mt-3">
        {(["today", "7d", "all"] as Range[]).map((r) => (
          <button key={r} type="button" onClick={() => setRange(r)} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", padding: "6px 12px", background: range === r ? palette.goldDeep : "transparent", color: range === r ? palette.ivory : palette.softBlack, border: range === r ? "none" : "1px solid rgba(26,26,26,0.18)" }}>
            {r === "today" ? "Today" : r === "7d" ? "7 Days" : "All Time"}
          </button>
        ))}
      </div>

      {/* Money tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
        {tile("Orders", String(tiles.orders))}
        {tile("Pieces", String(tiles.pieces))}
        {tile("Sales", formatINR(tiles.revenue), true)}
        {tile("Advance In", formatINR(tiles.advance))}
        {tile("Balance Due", formatINR(tiles.balance))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar mt-5">
        {tabBtn("products", "By Product")}
        {tabBtn("vendors", "By Vendor")}
        {tabBtn("customers", "By Customer")}
        {tabBtn("reorder", "Reorder")}
      </div>

      {/* Reorder-only controls: search + scan + vendor chips */}
      {tab === "reorder" && (
        <>
          <div className="mt-3 flex items-center gap-2 max-w-md" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px", background: palette.pageBg }}>
            <Search size={15} color={palette.mutedGreige} strokeWidth={1.7} />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlightSku(null); }}
              placeholder="Search product, SKU or vendor"
              className="font-body bg-transparent outline-none w-full"
              style={{ fontSize: 12.5, color: palette.black }}
            />
            {query && (
              <button type="button" onClick={() => { setQuery(""); setHighlightSku(null); }} aria-label="Clear search">
                <X size={14} color={palette.mutedGreige} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setScanning(true)}
              aria-label="Scan a tag"
              className="flex items-center gap-1.5 font-body uppercase flex-shrink-0"
              style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}
            >
              <ScanLine size={13} strokeWidth={1.7} /> Scan
            </button>
          </div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar mt-2">
            {vendorNames.map((v) => (
              <button key={v} type="button" onClick={() => setVendorFilter(v)} className="font-body whitespace-nowrap" style={{ fontSize: 10.5, padding: "5px 11px", background: vendorFilter === v ? palette.ivoryDeep : "transparent", color: palette.softBlack, border: `1px solid ${vendorFilter === v ? palette.gold : "rgba(26,26,26,0.15)"}` }}>
                {v}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mt-3 overflow-x-auto">
        {tab === "products" && (
          byProduct.length === 0 ? <Empty label="No items sold in this period." /> : (
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `1px solid ${palette.black}` }}>
                {th("")}
                <SortTh label="Product" k="product" sort={prodSort.sort} onToggle={prodSort.toggle} />
                <SortTh label="Pieces" k="pieces" sort={prodSort.sort} onToggle={prodSort.toggle} right defaultDir="desc" />
                <SortTh label="Value" k="value" sort={prodSort.sort} onToggle={prodSort.toggle} right defaultDir="desc" />
                <SortTh label="Orders" k="orders" sort={prodSort.sort} onToggle={prodSort.toggle} right defaultDir="desc" />
              </tr></thead>
              <tbody>
                {prodSort.sorted.map((r) => (
                  <tr key={r.sku} style={{ borderBottom: "1px solid rgba(26,26,26,0.07)" }}>
                    <td style={{ padding: "6px 8px", width: 44 }}>
                      {r.image ? <ZoomImage src={r.image} alt={r.title} width={36} height={45} /> : <div style={{ width: 36, height: 45, background: palette.ivoryDeep }} />}
                    </td>
                    {td(<><span className="font-display" style={{ fontSize: 13, fontWeight: 500 }}>{r.title}</span><br /><span style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.06em" }}>{r.sku}</span></>)}
                    {td(String(r.pieces), true, true)}
                    {td(formatINR(r.value), true)}
                    {td(String(r.orders.size), true)}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === "vendors" && (
          byVendor.length === 0 ? <Empty label="No items sold in this period." /> : (
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `1px solid ${palette.black}` }}>
                <SortTh label="Vendor" k="vendor" sort={vendSort.sort} onToggle={vendSort.toggle} />
                <SortTh label="Designs Sold" k="designs" sort={vendSort.sort} onToggle={vendSort.toggle} right defaultDir="desc" />
                <SortTh label="Pieces" k="pieces" sort={vendSort.sort} onToggle={vendSort.toggle} right defaultDir="desc" />
                <SortTh label="Value" k="value" sort={vendSort.sort} onToggle={vendSort.toggle} right defaultDir="desc" />
              </tr></thead>
              <tbody>
                {vendSort.sorted.map((r) => (
                  <tr key={r.vendor} style={{ borderBottom: "1px solid rgba(26,26,26,0.07)" }}>
                    {td(<span className="font-display" style={{ fontSize: 13, fontWeight: 500 }}>{r.vendor}</span>)}
                    {td(String(r.skus.size), true)}
                    {td(String(r.pieces), true, true)}
                    {td(formatINR(r.value), true)}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === "customers" && (
          byCustomer.length === 0 ? <Empty label="No orders in this period." /> : (
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `1px solid ${palette.black}` }}>
                <SortTh label="Customer" k="customer" sort={custSort.sort} onToggle={custSort.toggle} />
                <SortTh label="Orders" k="orders" sort={custSort.sort} onToggle={custSort.toggle} right defaultDir="desc" />
                <SortTh label="Pieces" k="pieces" sort={custSort.sort} onToggle={custSort.toggle} right defaultDir="desc" />
                <SortTh label="Total" k="total" sort={custSort.sort} onToggle={custSort.toggle} right defaultDir="desc" />
                <SortTh label="Advance" k="advance" sort={custSort.sort} onToggle={custSort.toggle} right defaultDir="desc" />
                <SortTh label="Balance" k="balance" sort={custSort.sort} onToggle={custSort.toggle} right defaultDir="desc" />
              </tr></thead>
              <tbody>
                {custSort.sorted.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.07)" }}>
                    {td(
                      <Link href={`/admin/buyers/${r.id}`} className="block">
                        <span className="font-display" style={{ fontSize: 13, fontWeight: 500, borderBottom: `1px solid ${palette.gold}` }}>{r.buyer?.business_name ?? "Unknown buyer"}</span><br />
                        <span style={{ fontSize: 9, color: palette.mutedGreige }}>{[r.buyer?.owner_name, r.buyer?.city, r.buyer?.phone].filter(Boolean).join(" · ")}</span>
                      </Link>,
                    )}
                    {td(String(r.orders), true)}
                    {td(String(r.pieces), true)}
                    {td(formatINR(r.total), true, true)}
                    {td(formatINR(r.advance), true)}
                    {td(
                      <span style={{ color: r.total - r.advance > 0 ? palette.crimsonText : palette.mutedGreige }}>
                        {formatINR(Math.max(0, r.total - r.advance))}
                      </span>,
                      true,
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === "reorder" && (
          reorderRows.length === 0 ? <Empty label="No products match." /> : (
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `1px solid ${palette.black}` }}>
                {th("")}
                <SortTh label="Product" k="product" sort={reordSort.sort} onToggle={reordSort.toggle} />
                <SortTh label="Vendor" k="vendor" sort={reordSort.sort} onToggle={reordSort.toggle} />
                <SortTh label="Vendor SKU" k="vendorSku" sort={reordSort.sort} onToggle={reordSort.toggle} />
                <SortTh label="Sheet Cost" k="cost" sort={reordSort.sort} onToggle={reordSort.toggle} right defaultDir="desc" />
                <SortTh label="Last GR Cost" k="grCost" sort={reordSort.sort} onToggle={reordSort.toggle} right defaultDir="desc" />
                <SortTh label="Last GR Date" k="grDate" sort={reordSort.sort} onToggle={reordSort.toggle} defaultDir="desc" />
                <SortTh label="Sold" k="sold" sort={reordSort.sort} onToggle={reordSort.toggle} right defaultDir="desc" />
                <SortTh label="In Stock" k="stock" sort={reordSort.sort} onToggle={reordSort.toggle} right defaultDir="desc" />
              </tr></thead>
              <tbody>
                {reordSort.sorted.map(({ p, v, sold, gr }) => (
                  <tr key={p.sku} style={{ borderBottom: "1px solid rgba(26,26,26,0.07)", background: highlightSku === p.sku ? palette.ivoryDeep : undefined }}>
                    <td style={{ padding: "6px 8px", width: 44 }}>
                      {p.image_urls?.[0]
                        ? <ZoomImage src={p.image_urls[0]} alt={p.title ?? p.sku} width={36} height={45} />
                        : <div className="flex items-center justify-center" style={{ width: 36, height: 45, background: palette.ivoryDeep }}><ImageOff size={13} color={palette.mutedGreige} /></div>}
                    </td>
                    {td(<><span className="font-display" style={{ fontSize: 13, fontWeight: 500 }}>{p.title ?? p.sku}</span><br /><span style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.06em" }}>{p.sku}</span></>)}
                    {td(v?.vendor_name?.trim() || <span style={{ color: palette.mutedGreige }}>—</span>)}
                    {td(
                      v?.vendor_sku?.trim() ? (
                        <button type="button" onClick={() => doCopy(v.vendor_sku!.trim(), p.sku)} className="inline-flex items-center gap-1.5 font-body" style={{ fontSize: 12, color: palette.black, background: "none", border: "none", padding: 0, cursor: "pointer" }} aria-label={`Copy vendor SKU ${v.vendor_sku}`}>
                          <span style={{ borderBottom: "1px dotted rgba(26,26,26,0.35)" }}>{v.vendor_sku.trim()}</span>
                          {copied === p.sku ? <Check size={12} color={palette.goldDeep} /> : <Copy size={12} color={palette.mutedGreige} />}
                        </button>
                      ) : (
                        <span style={{ color: palette.mutedGreige }}>—</span>
                      ),
                    )}
                    {td(
                      <span title="from sheet">{v && v.last_cost > 0 ? formatINR(v.last_cost) : "—"}</span>,
                      true,
                    )}
                    {td(
                      <span title="from Goods Receipts" style={{ color: gr ? palette.goldDeep : palette.mutedGreige }}>
                        {gr ? formatINR(gr.cost) : "—"}
                      </span>,
                      true,
                    )}
                    {td(
                      <span title="from Goods Receipts" style={{ color: palette.mutedGreige, fontSize: 11 }}>
                        {gr ? new Date(gr.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}
                      </span>,
                    )}
                    {td(sold > 0 ? <span style={{ color: palette.goldDeep, fontWeight: 600 }}>{sold}</span> : "0", true)}
                    {td(String(p.current_qty), true)}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      {tab !== "reorder" && (
        <p className="font-body mt-3" style={{ fontSize: 10, color: palette.mutedGreige }}>
          Pieces use the real count for GST-split lines. Product/vendor value is the line value before order-level discounts; cancelled orders are excluded.
        </p>
      )}

      {scanning && <QrScanner title="Scan a tag" onScan={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="font-body mt-4" style={{ fontSize: 12, color: palette.mutedGreige }}>{label}</p>;
}

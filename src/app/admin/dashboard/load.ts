import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { walletBalancesByBuyer } from "@/lib/credit-load";
import { loadVocab } from "@/lib/sku/vocab-live";
import { catalogCategoryFor } from "@/lib/studio/category-from-sku";
import type { OrderItem, OrderStatus } from "@/lib/types";
import { isCustomKey, lineKey, type DashBuyer, type DashLine, type DashOrder } from "@/lib/dashboard/lines";
import { buildVendorIndex } from "@/lib/dashboard/vendor";
import type { DashProduct, DesignSupply, VendorInfo } from "@/lib/dashboard/rollup";

interface OrderRow {
  id: string; order_number: string; status: OrderStatus; source: string; exhibition_event: string | null; total_amount: number;
  advance_amount: number | null; credit_applied: number | null; submitted_at: string; buyer_id: string; items: OrderItem[] | null;
}

export interface VendorProfile { id: string; name: string; phone: string | null; whatsapp: string | null; city: string | null }

// Every order goes to the browser, so a line carries only what the dashboard
// reads. Catalog titles and images come from the product, not each line.
function toDashOrder(o: OrderRow, catalog: Map<string, DashProduct>): DashOrder {
  const items = (o.items ?? []).map((it): DashLine => {
    const key = lineKey(it);
    const product = isCustomKey(key) ? undefined : catalog.get(key);
    return {
      sku: it.sku, qty: it.qty, unit_price: it.unit_price,
      ...(it.actual_qty != null ? { actual_qty: it.actual_qty } : {}),
      ...(it.returned_qty ? { returned_qty: it.returned_qty } : {}),
      ...(it.line_state ? { line_state: it.line_state } : {}),
      ...(it.line_state === "hold" && it.hold_note ? { hold_note: it.hold_note } : {}),
      ...(it.custom ? { custom: true } : {}),
      ...(it.billed_in ? { billed_in: "1" } : {}),
      ...(product?.title?.trim() ? {} : { title: it.title }),
      ...(product?.image_urls?.[0] ? {} : { image_url: it.image_url ?? null }),
    };
  });
  return { ...o, items };
}

// Shared loader for the dashboard AND the Stock-space /admin/reorder route
// (Stage 2 gives the Reorder view its own address; same data, same view).
// `withCredit` is here so /admin/reorder can skip the wallet aggregate it
// never renders; both callers take the default today.
export async function loadDashboardData(opts?: { withCredit?: boolean }) {
  const admin = createAdminClient();
  const withCredit = opts?.withCredit !== false;

  // PostgREST stops an un-ranged read at 1,000 rows without a word, so every
  // table here is paged. Orders page oldest first: a new order lands at the
  // tail and cannot shift a page boundary and be counted twice.
  const [orderRows, buyers, contacts, productRows, info, vendors, grReceipts, grLines, designs, vocab, walletByBuyer] = await Promise.all([
    fetchAll<OrderRow>(
      admin, "orders",
      // credit_applied: settled with a credit note, so every balance-due
      // figure below subtracts it rather than chasing money already paid.
      "id, order_number, status, source, exhibition_event, total_amount, advance_amount, credit_applied, submitted_at, buyer_id, items",
      (q) => q.order("submitted_at", { ascending: true }).order("id", { ascending: true }),
    ),
    fetchAll<DashBuyer>(admin, "buyers", "id, business_name, owner_name, phone, city", (q) => q.order("id")),
    fetchAll<{ buyer_id: string; first_name: string | null; last_name: string | null; phone: string | null }>(
      admin, "buyer_contacts", "buyer_id, first_name, last_name, phone", (q) => q.order("id"),
    ),
    fetchAll<DashProduct>(
      admin, "wholesale_products", "sku, title, image_urls, current_qty, wholesale_price, category, restockable, wholesale_visible",
      (q) => q.order("sku"),
    ),
    fetchAll<VendorInfo & { vendor_id: string | null }>(
      admin, "product_vendor_info", "sku, vendor_name, vendor_id, vendor_sku, last_cost, last_receipt_date", (q) => q.order("sku"),
    ),
    fetchAll<VendorProfile>(admin, "vendors", "id, name, phone, whatsapp, city", (q) => q.order("id")),
    fetchAll<{ id: string; receipt_number: string | null; receipt_date: string; created_at: string; vendor_id: string | null }>(
      admin, "goods_receipts", "id, receipt_number, receipt_date, created_at, vendor_id", (q) => q.order("id"),
    ),
    fetchAll<{ receipt_id: string; sku: string; unit_cost: number; vendor_sku: string | null }>(
      admin, "goods_receipt_lines", "receipt_id, sku, unit_cost, vendor_sku", (q) => q.order("id"),
    ),
    fetchAll<DesignSupply & { base_sku: string | null; color: string | null; vendor_id: string | null; vendor_sku: string | null }>(
      admin, "designs", "base_sku, color, vendor_id, vendor_sku, supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_note",
      (q) => q.order("id"),
    ),
    loadVocab(),
    withCredit ? walletBalancesByBuyer() : Promise.resolve(new Map<string, number>()),
  ]);

  // Latest goods-receipt cost per SKU (Phase 1 §8.5): by receipt_date, then
  // created_at. Shown ALONGSIDE the sheet-synced Last Cost — never replacing it.
  const recById = new Map(grReceipts.map((r) => [r.id, r]));
  const grLatest = new Map<string, { cost: number; date: string; createdAt: string }>();
  for (const l of grLines) {
    const rec = recById.get(l.receipt_id);
    if (!rec) continue;
    const sku = l.sku.toUpperCase();
    const cur = grLatest.get(sku);
    if (!cur || rec.receipt_date > cur.date || (rec.receipt_date === cur.date && rec.created_at > cur.createdAt)) {
      grLatest.set(sku, { cost: Number(l.unit_cost), date: rec.receipt_date, createdAt: rec.created_at });
    }
  }
  const grBySku: Record<string, { cost: number; date: string }> = {};
  for (const [sku, v] of grLatest) grBySku[sku] = { cost: v.cost, date: v.date };

  // A wallet balance is an all-time point-in-time number, not a flow — it is
  // handed over as a plain record because DashboardView is a client component.
  const creditByBuyer: Record<string, number> = {};
  for (const [buyerId, balance] of walletByBuyer) creditByBuyer[buyerId] = balance;

  const catalog = new Map(productRows.map((p) => [p.sku.trim().toUpperCase(), p]));
  const byId = new Map(orderRows.map((o) => [o.id, o])); // a page boundary may still repeat a row
  const orders = Array.from(byId.values()).reverse().map((o) => toDashOrder(o, catalog));

  // Portal-born products have no category of their own, so read it off the SKU.
  const products = productRows.map((p) => ({
    ...p,
    category: catalogCategoryFor({ category: p.category, subCategory: null }, p.sku, vocab).category,
  }));
  const categoryBySku: Record<string, string | null> = {};
  const soldSkus = new Set<string>();
  for (const o of orders) {
    for (const it of o.items) {
      const key = lineKey(it);
      if (isCustomKey(key)) continue;
      soldSkus.add(key);
      if (!catalog.has(key)) categoryBySku[key] = catalogCategoryFor({ category: null, subCategory: null }, key, vocab).category;
    }
  }

  const vendorBySku = buildVendorIndex({
    skus: [...catalog.keys(), ...soldSkus, ...info.map((v) => v.sku.trim().toUpperCase())],
    vendors, receipts: grReceipts, lines: grLines, info, designs,
  });

  const supplyByDesign: Record<string, DesignSupply> = {};
  for (const d of designs) {
    if (!d.base_sku || !d.color) continue;
    const { supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_note } = d;
    supplyByDesign[`${d.base_sku}|${d.color}`.toUpperCase()] = { supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_note };
  }

  const contactsByBuyer: Record<string, { name: string | null; phone: string | null }[]> = {};
  for (const c of contacts) {
    (contactsByBuyer[c.buyer_id] ??= []).push({ name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null, phone: c.phone });
  }

  return {
    orders,
    buyers,
    contactsByBuyer,
    products,
    info: info.map(({ sku, vendor_name, vendor_sku, last_cost, last_receipt_date }) => ({ sku, vendor_name, vendor_sku, last_cost, last_receipt_date })),
    vendorBySku,
    vendorProfiles: vendors,
    categoryBySku,
    supplyByDesign,
    grBySku,
    creditByBuyer,
    serverNow: Date.now(),
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboardData>>;

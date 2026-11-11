import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { BUYER_PRODUCT_COLUMNS, type WholesaleProduct } from "@/lib/types";
import { buildCategoryTree, type CategoryNode } from "@/lib/category-tree";
import { getStockState } from "@/lib/stock";

export type { CategoryNode } from "@/lib/category-tree";

// Buyer storefront home data (build guide §13). PRICING FIREWALL: everything
// returned here is buyer-safe — list wholesale prices only, never cost,
// vendor, or staff-only fields. Reorder ranking is real-pieces aware
// (actual_qty when a GST split was billed, else qty).

export interface ReorderItem {
  sku: string;
  title: string | null;
  imageUrl: string | null;
  wholesalePrice: number;
  minOrderQty: number | null;
  currentQty: number;
  restockable: boolean;
  pieces: number; // lifetime pieces this buyer took
  lastOrderedAt: string;
}

export interface BuyerHomeData {
  activeOrder: { id: string; orderNumber: string; status: string; pieces: number } | null;
  reorder: ReorderItem[];
  newThisWeek: WholesaleProduct[];
  /** Every buyer-visible design, including the ones with no category yet. */
  totalDesigns: number;
  /** Category → sub-category tree, biggest first; nothing with 0 designs. */
  categories: CategoryNode[];
}

export async function loadBuyerHome(buyerId: string): Promise<BuyerHomeData> {
  const admin = createAdminClient();
  const [{ data: orders }, { data: products }] = await Promise.all([
    admin
      .from("orders")
      .select("id, order_number, status, items, submitted_at")
      .eq("buyer_id", buyerId)
      .neq("status", "cancelled")
      .order("submitted_at", { ascending: false }),
    admin
      .from("wholesale_products")
      // NOT select("*"): newThisWeek is built by filtering these rows and is
      // handed straight to a client component, so a raw row would put rack
      // location and the cost/override pricing columns into the buyer page
      // payload. Same leak that put "Rack B2" in the product page RSC stream
      // on 2 Aug, which is why BUYER_PRODUCT_COLUMNS exists.
      .select(BUYER_PRODUCT_COLUMNS)
      .eq("buyer_visible", true),
    // No notify_me read: nothing on Home renders back-in-stock any more (the
    // strip went with the Notify-me button). Studio still reads the table as
    // a demand signal.
  ]);

  const bySku = new Map((products ?? []).map((p) => [p.sku.toUpperCase(), p as WholesaleProduct]));

  // Latest order still moving → status strip.
  const active = (orders ?? []).find((o) => ["submitted", "confirmed", "packed", "out_for_delivery"].includes(o.status));
  const activeOrder = active
    ? {
        id: active.id,
        orderNumber: active.order_number,
        status: active.status,
        pieces: ((active.items as { qty?: number; actual_qty?: number }[] | null) ?? []).reduce(
          (s, it) => s + (it.actual_qty ?? it.qty ?? 0),
          0,
        ),
      }
    : null;

  // Reorder your usuals — real pieces per SKU across this buyer's history.
  const tally = new Map<string, { pieces: number; last: string }>();
  for (const o of orders ?? []) {
    for (const it of ((o.items as { sku?: string; qty?: number; actual_qty?: number; custom?: boolean }[] | null) ?? [])) {
      if (!it.sku || it.custom) continue;
      const key = it.sku.toUpperCase();
      const prev = tally.get(key);
      const pieces = (prev?.pieces ?? 0) + (it.actual_qty ?? it.qty ?? 0);
      tally.set(key, { pieces, last: prev?.last ?? o.submitted_at });
    }
  }
  const reorder: ReorderItem[] = [...tally.entries()]
    .map(([sku, t]) => {
      const p = bySku.get(sku);
      if (!p) return null; // hidden or gone from the catalog
      return {
        sku: p.sku,
        title: p.title,
        imageUrl: (p.image_urls as string[] | null)?.[0] ?? null,
        wholesalePrice: p.wholesale_price,
        minOrderQty: p.min_order_qty,
        currentQty: p.current_qty,
        restockable: p.restockable,
        pieces: t.pieces,
        lastOrderedAt: t.last,
      };
    })
    .filter((x): x is ReorderItem => !!x)
    .sort((a, b) => b.pieces - a.pieces || b.lastOrderedAt.localeCompare(a.lastOrderedAt))
    .slice(0, 12);

  // New this week — first published ≤ 7 days ago (published set beats sync).
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: freshImages } = await admin
    .from("product_images")
    .select("sku_base, color, published_at")
    .gte("published_at", weekAgo);
  const freshGroups = new Set((freshImages ?? []).map((f) => `${f.sku_base}|${f.color}`.toUpperCase()));
  // One tile per design + colour. Every size is its own row with the same
  // photo, title and price, so two fresh 4-size designs used to fill all 8
  // tiles with copies of themselves. The tile prefers a size that can still be
  // ordered: rows come back in no fixed order, and a sold-out first size made
  // the tile a dead end (the tile links to that one SKU).
  const tileByGroup = new Map<string, WholesaleProduct>();
  for (const p of (products ?? []) as WholesaleProduct[]) {
    const parts = p.sku.toUpperCase().split("-");
    if (parts.length < 5 || !/^\d{2,4}$/.test(parts[3])) continue;
    const group = `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`;
    if (!freshGroups.has(group)) continue;
    const kept = tileByGroup.get(group);
    if (!kept || (getStockState(kept) === "sold_out" && getStockState(p) !== "sold_out")) tileByGroup.set(group, p);
  }
  const newThisWeek = [...tileByGroup.values()];

  const { totalDesigns, categories } = buildCategoryTree((products ?? []) as WholesaleProduct[]);

  return { activeOrder, reorder, newThisWeek: newThisWeek.slice(0, 8), totalDesigns, categories };
}

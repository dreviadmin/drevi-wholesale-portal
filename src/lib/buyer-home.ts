import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { WholesaleProduct } from "@/lib/types";

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
  backInStock: { sku: string; title: string | null; imageUrl: string | null }[];
  categories: string[];
}

export async function loadBuyerHome(buyerId: string): Promise<BuyerHomeData> {
  const admin = createAdminClient();
  const [{ data: orders }, { data: products }, { data: notifies }] = await Promise.all([
    admin
      .from("orders")
      .select("id, order_number, status, items, submitted_at")
      .eq("buyer_id", buyerId)
      .neq("status", "cancelled")
      .order("submitted_at", { ascending: false }),
    admin
      .from("wholesale_products")
      .select("*")
      .eq("wholesale_visible", true),
    admin.from("notify_me").select("sku_base, color").eq("buyer_id", buyerId).is("fulfilled_at", null),
  ]);

  const bySku = new Map((products ?? []).map((p) => [p.sku.toUpperCase(), p as WholesaleProduct]));

  // Latest order still moving → status strip.
  const active = (orders ?? []).find((o) => o.status === "submitted" || o.status === "confirmed");
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
  const newThisWeek = (products ?? []).filter((p) => {
    const parts = p.sku.toUpperCase().split("-");
    if (parts.length < 5 || !/^\d{2,4}$/.test(parts[3])) return false;
    return freshGroups.has(`${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`);
  }) as WholesaleProduct[];

  // Back-in-stock: this buyer's open notify requests whose group now has stock.
  const backInStock: BuyerHomeData["backInStock"] = [];
  for (const n of notifies ?? []) {
    const match = (products ?? []).find((p) => {
      const parts = p.sku.toUpperCase().split("-");
      return (
        parts.slice(0, 4).join("-") === n.sku_base.toUpperCase() &&
        parts[parts.length - 1] === n.color.toUpperCase() &&
        (p.current_qty ?? 0) > 0
      );
    });
    if (match) backInStock.push({ sku: match.sku, title: match.title, imageUrl: (match.image_urls as string[] | null)?.[0] ?? null });
  }

  const categories = [...new Set((products ?? []).map((p) => p.category).filter((c): c is string => !!c))].sort();

  return { activeOrder, reorder, newThisWeek: newThisWeek.slice(0, 8), backInStock, categories };
}

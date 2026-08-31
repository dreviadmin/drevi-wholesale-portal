import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

// Order ↔ catalog resync (Ansh, 30 Jul): order items snapshot the catalog at
// billing time, so a SKU touched afterwards (photo added, title fixed, HSN
// filled) leaves stale orders behind. This refreshes the DESCRIPTIVE fields —
// title, image_url, hsn — from today's catalog.
//
// It NEVER touches qty, unit_price, actual_qty or any billing figure: money
// on a placed order only changes through the explicit order editor. Custom
// (off-catalog) lines are skipped entirely.

interface OrderItemLike {
  sku?: string;
  custom?: boolean;
  title?: string;
  image_url?: string | null;
  hsn?: string | null;
  [k: string]: unknown;
}

export interface RefreshResult {
  changed: boolean;
  touchedSkus: string[];
}

export function refreshItems(
  items: OrderItemLike[],
  bySku: Map<string, { title: string | null; image_url: string | null; hsn: string | null }>,
): { items: OrderItemLike[]; result: RefreshResult } {
  const touched: string[] = [];
  const next = items.map((it) => {
    if (!it.sku || it.custom) return it;
    const p = bySku.get(it.sku.trim().toUpperCase());
    if (!p) return it;
    const patch: Partial<OrderItemLike> = {};
    if (p.title && p.title !== it.title) patch.title = p.title;
    if (p.image_url && p.image_url !== it.image_url) patch.image_url = p.image_url;
    if (p.hsn && p.hsn !== it.hsn) patch.hsn = p.hsn;
    if (Object.keys(patch).length === 0) return it;
    touched.push(it.sku);
    return { ...it, ...patch };
  });
  return { items: next, result: { changed: touched.length > 0, touchedSkus: touched } };
}

/** Refresh one order's items from the live catalog. Returns what changed. */
export async function refreshOrderFromCatalog(
  admin: SupabaseClient,
  orderId: string,
): Promise<{ ok: boolean; error?: string } & Partial<RefreshResult>> {
  const { data: order } = await admin.from("orders").select("id, items").eq("id", orderId).maybeSingle();
  if (!order) return { ok: false, error: "Order not found" };
  const items = (order.items ?? []) as OrderItemLike[];
  const skus = [...new Set(items.filter((i) => i.sku && !i.custom).map((i) => i.sku!.trim().toUpperCase()))];
  if (skus.length === 0) return { ok: true, changed: false, touchedSkus: [] };

  const { data: products } = await admin
    .from("wholesale_products")
    .select("sku, title, image_urls, hsn")
    .in("sku", skus);
  const bySku = new Map(
    (products ?? []).map((p) => [
      p.sku.trim().toUpperCase(),
      { title: p.title, image_url: (p.image_urls as string[] | null)?.[0] ?? null, hsn: p.hsn ?? null },
    ]),
  );

  const { items: next, result } = refreshItems(items, bySku);
  if (!result.changed) return { ok: true, ...result };
  const { error } = await admin.from("orders").update({ items: next }).eq("id", orderId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, ...result };
}

/** States whose orders auto-refresh after a catalog sync. Terminal orders are history — left alone. */
export const AUTO_REFRESH_STATUSES = ["submitted", "confirmed", "packed", "out_for_delivery"];

/**
 * Auto pass for the catalog sync: refresh every ACTIVE order. Returns how many
 * orders changed. Failures on one order never stop the rest.
 */
export async function refreshActiveOrders(admin: SupabaseClient): Promise<{ checked: number; updated: number }> {
  const { data: orders } = await admin.from("orders").select("id").in("status", AUTO_REFRESH_STATUSES).limit(500);
  let updated = 0;
  for (const o of orders ?? []) {
    try {
      const r = await refreshOrderFromCatalog(admin, o.id);
      if (r.ok && r.changed) updated++;
    } catch { /* one bad order must not break the sync */ }
  }
  return { checked: (orders ?? []).length, updated };
}

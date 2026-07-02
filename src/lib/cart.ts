import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getStockState, qtyCap } from "@/lib/stock";
import type { WholesaleProduct, StockState } from "@/lib/types";

export interface RawCartItem {
  sku: string;
  qty: number;
  // Client-raised "special quantity request": bypasses MOQ/cap blocks, flagged
  // through to the order + PDF for Rakesh's confirmation.
  special?: boolean;
}

export interface CartLine {
  product: WholesaleProduct;
  qty: number;
  stockState: StockState;
  cap: number | null; // upper bound (Limited), else null
  belowMoq: boolean;
  special: boolean;
  lineTotal: number;
}

export interface DetailedCart {
  lines: CartLine[];
  subtotal: number;
  count: number; // distinct lines (for the header badge)
  totalQty: number;
  hasBlock: boolean; // any line below its MOQ
  maxLeadDays: number; // max restock_days among Made-to-Order lines
}

export async function getRawCart(buyerId: string): Promise<RawCartItem[]> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("carts").select("items").eq("buyer_id", buyerId).maybeSingle();
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is RawCartItem => i && typeof i.sku === "string" && Number.isFinite(i.qty))
    .map((i) => ({ sku: i.sku, qty: Math.max(1, Math.floor(i.qty)), special: i.special === true }));
}

export async function getDetailedCart(buyerId: string): Promise<DetailedCart> {
  const items = await getRawCart(buyerId);
  if (items.length === 0) {
    return { lines: [], subtotal: 0, count: 0, totalQty: 0, hasBlock: false, maxLeadDays: 0 };
  }

  const supabase = createAdminClient();
  const { data: prods } = await supabase
    .from("wholesale_products")
    .select("*")
    .in("sku", items.map((i) => i.sku));
  const bySku = new Map<string, WholesaleProduct>((prods ?? []).map((p) => [p.sku, p as WholesaleProduct]));

  const lines: CartLine[] = [];
  for (const it of items) {
    const product = bySku.get(it.sku);
    if (!product || !product.wholesale_visible) continue; // drop hidden/stale
    const stockState = getStockState(product);
    if (stockState === "sold_out") continue; // sold out can't be ordered
    const cap = qtyCap(product);
    const special = it.special === true;
    // Special requests carry the exact asked-for qty (no clamp) — flagged for
    // Rakesh rather than blocked.
    const qty = !special && cap != null ? Math.min(it.qty, cap) : it.qty;
    const belowMoq = product.min_order_qty != null && qty < product.min_order_qty;
    lines.push({ product, qty, stockState, cap, belowMoq, special, lineTotal: qty * product.wholesale_price });
  }

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const hasBlock = lines.some((l) => l.belowMoq && !l.special);
  const maxLeadDays = lines
    .filter((l) => l.stockState === "made_to_order")
    .reduce((m, l) => Math.max(m, l.product.restock_days ?? 0), 0);

  return { lines, subtotal, count: lines.length, totalQty, hasBlock, maxLeadDays };
}

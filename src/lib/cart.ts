import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { buildCartLines, type CartLineChanges } from "@/lib/cart-lines";
import type { WholesaleProduct, StockState } from "@/lib/types";
import { BUYER_PRODUCT_COLUMNS } from "@/lib/types";

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

export interface DetailedCart extends CartLineChanges {
  lines: CartLine[];
  subtotal: number;
  count: number; // distinct lines (for the header badge)
  totalQty: number;
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
    return { lines: [], dropped: [], adjusted: [], subtotal: 0, count: 0, totalQty: 0, maxLeadDays: 0 };
  }

  const supabase = createAdminClient();
  const { data: prods } = await supabase
    .from("wholesale_products")
    .select(BUYER_PRODUCT_COLUMNS)
    .in("sku", items.map((i) => i.sku));
  const bySku = new Map<string, WholesaleProduct>((prods ?? []).map((p) => [p.sku, p as WholesaleProduct]));

  // Drops hidden, missing and sold-out rows and holds Limited lines to stock,
  // reporting both so the cart page can tell the buyer (src/lib/cart-lines.ts).
  const { lines, dropped, adjusted } = buildCartLines(items, bySku);

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const maxLeadDays = lines
    .filter((l) => l.stockState === "made_to_order")
    .reduce((m, l) => Math.max(m, l.product.restock_days ?? 0), 0);

  return { lines, dropped, adjusted, subtotal, count: lines.length, totalQty, maxLeadDays };
}

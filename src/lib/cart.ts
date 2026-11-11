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
  /**
   * The cart or its products could not be read. Everything else is empty, and
   * nothing is reported dropped: a read that failed says nothing about what is
   * still orderable, and the cart page settles dropped rows by deleting them
   * (Nov review: one failed product read emptied a buyer's stored cart).
   */
  readFailed?: boolean;
}

const EMPTY_CART: DetailedCart = { lines: [], dropped: [], adjusted: [], subtotal: 0, count: 0, totalQty: 0, maxLeadDays: 0 };

/**
 * The stored rows. Throws when the read fails rather than passing for an empty
 * cart: every cart write starts from this list and saves it whole, so a failed
 * read taken as "empty" would overwrite every other line.
 */
export async function getRawCart(buyerId: string): Promise<RawCartItem[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("carts").select("items").eq("buyer_id", buyerId).maybeSingle();
  if (error) throw new Error(`Cart read failed: ${error.message}`);
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is RawCartItem => i && typeof i.sku === "string" && Number.isFinite(i.qty))
    .map((i) => ({ sku: i.sku, qty: Math.max(1, Math.floor(i.qty)), special: i.special === true }));
}

/** The buyer's orderable cart. Never throws for a failed read: see readFailed. */
export async function getDetailedCart(buyerId: string): Promise<DetailedCart> {
  let items: RawCartItem[];
  try {
    items = await getRawCart(buyerId);
  } catch (err) {
    console.error("[cart]", (err as Error).message);
    return { ...EMPTY_CART, readFailed: true };
  }
  return detailCartItems(items);
}

/** Stored rows → the lines the buyer can order, with what changed (see getDetailedCart). */
export async function detailCartItems(items: RawCartItem[]): Promise<DetailedCart> {
  if (items.length === 0) return { ...EMPTY_CART };

  const supabase = createAdminClient();
  const { data: prods, error } = await supabase
    .from("wholesale_products")
    .select(BUYER_PRODUCT_COLUMNS)
    .in("sku", items.map((i) => i.sku));
  if (error) {
    console.error("[cart] product read failed:", error.message);
    return { ...EMPTY_CART, readFailed: true };
  }
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

import { getStockState, qtyCap } from "@/lib/stock";
import { buyerVariantLabel } from "@/lib/variants";
import type { CartLine, RawCartItem } from "@/lib/cart";
import type { WholesaleProduct } from "@/lib/types";

// Stored cart rows → the lines the buyer can order. Pulled out of
// getDetailedCart (Oct review) so the cart can say what it dropped or cut
// instead of items quietly vanishing or changing. The rules are unchanged:
// hidden, missing and sold-out products drop; a Limited line is held to what
// is on hand unless it is a special request.

export interface CartLineChanges {
  /** Rows no longer orderable. `title` is null when the product row is gone. */
  dropped: { sku: string; title: string | null }[];
  /** Non-special lines shown at less than the stored quantity. */
  adjusted: string[];
}

export function buildCartLines(
  items: RawCartItem[],
  bySku: Map<string, WholesaleProduct>,
): { lines: CartLine[] } & CartLineChanges {
  const lines: CartLine[] = [];
  const dropped: CartLineChanges["dropped"] = [];
  const adjusted: string[] = [];
  for (const it of items) {
    const product = bySku.get(it.sku);
    if (!product || !product.buyer_visible) { // hidden/stale
      dropped.push({ sku: it.sku, title: product?.title ?? null });
      continue;
    }
    const stockState = getStockState(product);
    if (stockState === "sold_out") { // sold out can't be ordered
      dropped.push({ sku: it.sku, title: product.title });
      continue;
    }
    const cap = qtyCap(product);
    const special = it.special === true;
    // Special requests carry the exact asked-for qty (no clamp) — flagged for
    // Rakesh rather than blocked.
    const qty = !special && cap != null ? Math.min(it.qty, cap) : it.qty;
    if (qty < it.qty) adjusted.push(it.sku);
    const belowMoq = product.min_order_qty != null && qty < product.min_order_qty;
    lines.push({ product, qty, stockState, cap, belowMoq, special, lineTotal: qty * product.wholesale_price });
  }
  return { lines, dropped, adjusted };
}

/**
 * How the notice names each changed item: its title, or the SKU when the
 * product row is gone. Buyers order several sizes of one design, and hiding
 * that design drops all of them, so a title shared by two changed items gets
 * its size and colour ("Rose Anarkali (M · Cream)"), or its SKU when it has
 * none, rather than reading "Rose Anarkali and Rose Anarkali".
 */
export function changedItemNames(items: { sku: string; title: string | null }[]): string[] {
  const uses = new Map<string, number>();
  for (const it of items) if (it.title) uses.set(it.title, (uses.get(it.title) ?? 0) + 1);
  return items.map((it) => {
    if (!it.title) return it.sku;
    if ((uses.get(it.title) ?? 0) < 2) return it.title;
    return `${it.title} (${buyerVariantLabel(it.sku) ?? it.sku})`;
  });
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The one line the cart shows about it, or null when nothing changed. No
 * quantities: the buyer cart states no stock, so "adjusted" never says to what.
 */
export function cartChangeNotice(droppedTitles: string[], adjustedTitles: string[]): string | null {
  const total = droppedTitles.length + adjustedTitles.length;
  if (total === 0) return null;
  const parts = [total === 1 ? "An item changed since you added it:" : "Some items changed since you added them:"];
  if (droppedTitles.length === 1) parts.push(`${droppedTitles[0]} is no longer available and was removed.`);
  else if (droppedTitles.length > 1) parts.push(`${listOf(droppedTitles)} are no longer available and were removed.`);
  if (adjustedTitles.length === 1) parts.push(`The quantity of ${adjustedTitles[0]} was adjusted.`);
  else if (adjustedTitles.length > 1) parts.push(`The quantities of ${listOf(adjustedTitles)} were adjusted.`);
  return parts.join(" ");
}

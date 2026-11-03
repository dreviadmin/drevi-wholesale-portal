import type { OrderItem, OrderStatus } from "@/lib/types";
import { designKeyOf } from "../retail-price-core";
import { effectiveLineState } from "../order-lines-core";

// One order line in the only forms the dashboard sums it. Every view goes
// through these, so a drill-down's rows add up to the row it opened from.

/** The fields the dashboard reads. billed_in only has to be truthy here. */
export type DashLine = Pick<OrderItem, "sku" | "qty" | "unit_price" | "actual_qty" | "returned_qty" | "line_state" | "hold_note" | "custom" | "image_url"> & {
  title?: string; // only when the catalog cannot supply it
  billed_in?: string | null;
};

export interface DashOrder {
  id: string;
  order_number: string;
  status: OrderStatus;
  source: string;
  exhibition_event: string | null;
  total_amount: number;
  advance_amount: number | null;
  credit_applied: number | null;
  submitted_at: string;
  buyer_id: string;
  items: DashLine[];
}

export interface DashBuyer {
  id: string;
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
}

/** Real pieces: a GST bill-split inflates qty on paper, actual_qty keeps the truth. */
export const piecesOf = (it: DashLine) => it.actual_qty ?? it.qty;

/** qty x unit_price IS the money, on a split line too. Before order discount and added GST. */
export const lineValue = (it: DashLine) => it.qty * it.unit_price;

/** returned_qty is in billed units; this is the same return in real pieces. */
export function returnedPieces(it: DashLine): number {
  const returned = Number(it.returned_qty) || 0;
  if (!returned || !it.qty) return 0;
  return Math.min(piecesOf(it), Math.round((returned * piecesOf(it)) / it.qty));
}

const normTitle = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);

/** Shared by vendor and category names, so a stray space or capital never splits a row. */
export const normName = normTitle;

/**
 * Every free-typed piece is stored under the literal SKU CUSTOM, so custom lines
 * key on their title or unrelated pieces would merge into one fake best-seller.
 */
export function lineKey(it: Pick<DashLine, "sku" | "title">): string {
  const sku = (it.sku ?? "").trim().toUpperCase();
  if (!sku || sku === "CUSTOM" || sku.startsWith("CUSTOM-")) return `custom:${normTitle(it.title ?? "")}`;
  return sku;
}

export const isCustomKey = (key: string) => key.startsWith("custom:");

/** SKUs carry size and colour; what people call a product is the base and colour. */
export const designOf = (key: string) => (isCustomKey(key) ? key : designKeyOf(key) ?? key);

/** The one rule for what an order still owes, the same as Home and the Orders page. */
export function orderBalance(o: Pick<DashOrder, "status" | "total_amount" | "advance_amount" | "credit_applied">): number {
  if (o.status === "cancelled") return 0;
  return Math.max(0, (o.total_amount || 0) - (o.advance_amount || 0) - (Number(o.credit_applied) || 0));
}

export function orderOverpaid(o: Pick<DashOrder, "status" | "total_amount" | "advance_amount" | "credit_applied">): number {
  if (o.status === "cancelled") return 0;
  return Math.max(0, (o.advance_amount || 0) + (Number(o.credit_applied) || 0) - (o.total_amount || 0));
}

export type PendingState = "hold" | "pending";

export function pendingState(it: DashLine, status: OrderStatus): PendingState | null {
  const state = effectiveLineState(it, status);
  return state === "hold" || state === "pending" ? state : null;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Exhibition buyers can come in with only a name or a phone. */
export function partyName(b: DashBuyer | null | undefined): string {
  return b?.business_name?.trim() || b?.owner_name?.trim() || b?.phone?.trim() || "Unknown customer";
}

import type { StockState } from "@/lib/types";

// Minimal shape the four-state model needs. Real products satisfy it; the
// prototype legend passes the same three fields.
export interface StockInput {
  current_qty: number;
  restockable: boolean;
  restock_days?: number | null;
}

/**
 * The single source of truth for the four-state stock model (CLAUDE.md, spec §4.2).
 * Implemented once here and reused across catalog, detail, cart, and PDF.
 *
 *  | current_qty | restockable | state          | orderable | qty cap        |
 *  | > 0         | true        | ready          | yes       | none           |
 *  | > 0         | false       | limited        | yes       | current_qty    |
 *  | 0           | true        | made_to_order  | yes       | none           |
 *  | 0           | false       | sold_out       | no        | —              |
 */
export function getStockState(p: StockInput): StockState {
  if (p.current_qty > 0 && p.restockable) return "ready";
  if (p.current_qty > 0 && !p.restockable) return "limited";
  if (p.current_qty <= 0 && p.restockable) return "made_to_order";
  return "sold_out";
}

export function canOrder(p: StockInput): boolean {
  return getStockState(p) !== "sold_out";
}

/** Upper bound on the orderable quantity, or null when unbounded. */
export function qtyCap(p: StockInput): number | null {
  return getStockState(p) === "limited" ? p.current_qty : null;
}

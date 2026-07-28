import type { StockState } from "@/lib/types";
import { computeAvailability, type SupplyInput } from "@/lib/availability";

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
  // Retrofit R7 (§9.1): ONE implementation. The four-state model the cart and
  // PDF speak is now a projection of computeAvailability, not a second copy.
  // `restockable` is the pre-supply-data stand-in — a design with real supply
  // fields goes through availabilityForSkus instead.
  const supply: SupplyInput = {
    supplyMode: p.restockable ? "made_to_order" : "",
    vendorStockQty: null,
    makingDays: null,
    deliveryDays: p.restock_days ?? null,
    makingMoq: null,
    supplyUpdatedAt: null,
  };
  const a = computeAvailability({
    ourStock: p.current_qty,
    supply,
    buyerMoq: 1,
    handlingDays: 0,
    bufferDays: 0,
    // The legacy model calls ANY on-hand quantity "limited" when the SKU is not
    // restockable, so the threshold has to be effectively unbounded here.
    limitedThreshold: p.restockable ? 0 : Number.MAX_SAFE_INTEGER,
  });
  switch (a.state) {
    case "in_stock": return "ready";
    case "limited": return "limited";
    case "on_order_ready":
    case "made_to_order": return "made_to_order";
    default: return "sold_out";
  }
}

export function canOrder(p: StockInput): boolean {
  return getStockState(p) !== "sold_out";
}

/** Upper bound on the orderable quantity, or null when unbounded. */
export function qtyCap(p: StockInput): number | null {
  return getStockState(p) === "limited" ? p.current_qty : null;
}

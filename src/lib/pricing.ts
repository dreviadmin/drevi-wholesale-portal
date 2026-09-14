// Price points for the Product Master editor (build guide §12.1). Pure and
// shared so the preview MasterEditor draws and the number savePricing stores
// come from the same function — a preview that rounds differently from the
// save is how a user ends up arguing with the screen.
//
// Both autos stand on product_vendor_info.last_cost, which the 10-minute sheet
// sync rewrites with NO lock of its own: the cost can move under a user
// between visits, so a preview seen yesterday is not a promise. That is
// pre-existing for the MRP (0020) and equally true of the wholesale — the
// override is the only way to pin a number.

/** Retail price point — the guide's cost × tier multiplier → nearest ₹…99. */
export function to99(n: number): number {
  return Math.max(99, Math.round(n / 100) * 100 - 1);
}

/** Wholesale price point — trade prices are quoted round, not psychological:
 *  170 of the 197 priced SKUs on the live portal sit on a multiple of ₹50. */
export function to50(n: number): number {
  return Math.max(50, Math.round(n / 50) * 50);
}

/** 0020 seeded the retail multiplier at 2.5 (standard) / 3.0 (hero). */
export const DEFAULT_MARKUP_MULTIPLIER = 2.5;
/** 0050 seeded the wholesale multiplier at the live book's median, 1.2× cost. */
export const DEFAULT_WHOLESALE_MULTIPLIER = 1.2;

/** Below 1 would price under cost; above 10 is a slipped keypad, not a margin. */
export function clampMultiplier(value: number, fallback: number): number {
  const n = Number(value);
  return Math.min(10, Math.max(1, Number.isFinite(n) && n > 0 ? n : fallback));
}

/** null when there is no cost to multiply — the editor says "needs a cost". */
export function autoMrpFrom(lastCost: number, multiplier: number): number | null {
  return lastCost > 0 ? to99(lastCost * multiplier) : null;
}

export function autoWholesaleFrom(lastCost: number, multiplier: number): number | null {
  return lastCost > 0 ? to50(lastCost * multiplier) : null;
}

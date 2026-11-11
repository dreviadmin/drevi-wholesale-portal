// Retrofit R8 (§3.5, §10) — the PURE half of the ledger: the canonical stock
// calculation and its types. No server-only imports, so tests and client
// components can use it directly.
//
// Canonical stock for a SKU:
//   latest reset R (by created_at)
//   stock = R.snapshot_qty + Σ(delta) for movements created_at > R.created_at
//         (no reset yet → Σ(delta) over all movements)

export type MovementReason = "reset" | "receipt" | "order" | "manual" | "correction" | "shopify_sync" | "return" | "receipt_reversed";

export interface Movement {
  id: string;
  sku: string;
  delta: number;
  snapshot_qty: number | null;
  reason: MovementReason;
  ref_type: string | null;
  ref_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

/** Canonical quantity from the ledger. Single implementation (§3.5). */
export function canonicalFromMovements(movements: Movement[]): number {
  if (movements.length === 0) return 0;
  const sorted = [...movements].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let lastResetIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].reason === "reset") { lastResetIdx = i; break; }
  }
  if (lastResetIdx === -1) return sorted.reduce((s, m) => s + (m.delta ?? 0), 0);
  const base = sorted[lastResetIdx].snapshot_qty ?? 0;
  return base + sorted.slice(lastResetIdx + 1).reduce((s, m) => s + (m.delta ?? 0), 0);
}

/** Canonical quantity per SKU (upper-cased) for every SKU that has movements. */
export function canonicalBySku(movements: Movement[]): Map<string, number> {
  const bySku = new Map<string, Movement[]>();
  for (const m of movements) {
    const k = m.sku.trim().toUpperCase();
    const list = bySku.get(k);
    if (list) list.push(m);
    else bySku.set(k, [m]);
  }
  const out = new Map<string, number>();
  for (const [k, list] of bySku) out.set(k, canonicalFromMovements(list));
  return out;
}

/**
 * What the sheet sync does with current_qty for one SKU (audit round 2, 4 Oct):
 * a number to write, or null for "leave the column alone".
 *
 * The portal has been the stock master since the 31 Aug cutover: stock moves
 * only through the ledger, and applyMovement keeps the cached column equal to
 * it. The sync used to write the sheet's Current Qty over that cache for every
 * SKU without a current_qty lock — the lock was only ever stamped by
 * set-all-stock.mjs, so SKUs the sheet added later had none — and a stale
 * sheet number then read as "Sold Out" at the booth and skewed the next
 * Product Master edit. So:
 *   - a SKU WITH movements is the ledger's: an existing row is not written at
 *     all (null), and a row the sync is about to create is seeded from it;
 *   - a SKU the ledger has never seen still takes the sheet's number, so new
 *     sheet-only SKUs are created exactly as before. That number is not lost
 *     when the SKU first moves: applyMovement seeds it as the opening balance
 *     (openingBalanceFor below), after which the SKU is the ledger's;
 *   - `ledger` null means the movements could not be read: no existing row is
 *     written (it may be the ledger's), and a new row takes the sheet's number,
 *     as it always did.
 */
export function sheetSyncQty(
  sku: string,
  sheetQty: number,
  rowExists: boolean,
  ledger: Map<string, number> | null,
): number | null {
  if (ledger === null) return rowExists ? null : sheetQty;
  const owned = ledger.get(sku.trim().toUpperCase());
  if (owned === undefined) return sheetQty;
  return rowExists ? null : owned;
}

/**
 * The opening-balance row applyMovement writes before a SKU's FIRST movement
 * (review fix, 11 Nov), or null when none is needed.
 *
 * A SKU the ledger has never seen still has a count: the sheet's Current Qty
 * the sync wrote (sheetSyncQty), or a hand edit in Manage Catalog. The ledger
 * held none of it, so the first sale of 1 on a SKU showing 10 computed −1 from
 * that one movement, and from then on the sync left the column to the ledger:
 * the 10 pieces were gone for good. Seeding the shown count first — the same
 * opening balance 0026 gave every SKU that existed then — lets the movement net
 * off it (10 − 1 = 9, 10 + 3 = 13).
 *
 * A zero count needs nothing. A positive one is a reset to it; a negative one
 * cannot be a reset (a counted quantity is never below zero), so it is carried
 * as a correction, which keeps the balance honest the way a rename's carry does.
 */
export function openingBalanceFor(
  shownQty: number | null | undefined,
): { reason: "reset"; delta: 0; snapshot_qty: number } | { reason: "correction"; delta: number; snapshot_qty: null } | null {
  const shown = Math.trunc(Number(shownQty) || 0);
  if (shown === 0) return null;
  return shown > 0 ? { reason: "reset", delta: 0, snapshot_qty: shown } : { reason: "correction", delta: shown, snapshot_qty: null };
}

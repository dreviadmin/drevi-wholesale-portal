// Retrofit R8 (§3.5, §10) — the PURE half of the ledger: the canonical stock
// calculation and its types. No server-only imports, so tests and client
// components can use it directly.
//
// Canonical stock for a SKU:
//   latest reset R (by created_at)
//   stock = R.snapshot_qty + Σ(delta) for movements created_at > R.created_at
//         (no reset yet → Σ(delta) over all movements)

export type MovementReason = "reset" | "receipt" | "order" | "manual" | "correction" | "shopify_sync";

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

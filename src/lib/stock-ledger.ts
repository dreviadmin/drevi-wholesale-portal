import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// Retrofit R8 (§3.5, §10) — Supabase is authoritative for inventory.
//
// Canonical stock for a SKU:
//   latest reset R (by created_at)
//   stock = R.snapshot_qty + Σ(delta) for movements created_at > R.created_at
//         (no reset yet → Σ(delta) over all movements)
//
// wholesale_products.current_qty is the fast cached read; every mutation goes
// through applyMovement(), which writes the movement AND sets the cache to the
// canonical value — never an unchecked increment, so the cache cannot drift.

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

export async function movementsFor(sku: string): Promise<Movement[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("stock_movements")
    .select("*")
    .eq("sku", sku.trim().toUpperCase())
    .order("created_at", { ascending: true });
  return (data ?? []) as Movement[];
}

export async function canonicalStock(sku: string): Promise<number> {
  return canonicalFromMovements(await movementsFor(sku));
}

/**
 * Write one movement and refresh the cached quantity to the canonical value.
 * Every stock mutation in the app goes through here (§10.1).
 */
export async function applyMovement(input: {
  sku: string;
  delta?: number;
  snapshotQty?: number;
  reason: MovementReason;
  refType?: string;
  refId?: string;
  note?: string;
  createdBy?: string;
}): Promise<{ ok: boolean; error?: string; stock?: number }> {
  const admin = createAdminClient();
  const sku = input.sku.trim().toUpperCase();
  const isReset = input.reason === "reset";
  if (isReset && (input.snapshotQty == null || input.snapshotQty < 0)) {
    return { ok: false, error: "A reset needs a counted quantity" };
  }
  const { error } = await admin.from("stock_movements").insert({
    sku,
    delta: isReset ? 0 : Math.trunc(input.delta ?? 0),
    snapshot_qty: isReset ? Math.trunc(input.snapshotQty!) : null,
    reason: input.reason,
    ref_type: input.refType ?? null,
    ref_id: input.refId ?? null,
    note: input.note ?? null,
    created_by: input.createdBy ?? null,
  });
  if (error) return { ok: false, error: error.message };

  const stock = await canonicalStock(sku);
  // Cache follows the ledger. A SKU with no product row (a mint not yet in the
  // catalog) simply has no cache to update — the ledger still holds the truth.
  await admin.from("wholesale_products").update({ current_qty: stock }).eq("sku", sku);
  return { ok: true, stock };
}

/** §10.3 — drift between the ledger and the cached column, per SKU. */
export async function reconcile(): Promise<{
  checked: number;
  drift: { sku: string; cached: number; ledger: number; lastReset: string | null; recent: Movement[] }[];
}> {
  const admin = createAdminClient();
  const { data: products } = await admin.from("wholesale_products").select("sku, current_qty");
  const { data: all } = await admin.from("stock_movements").select("*").order("created_at", { ascending: true }).limit(20000);
  const bySku = new Map<string, Movement[]>();
  for (const m of (all ?? []) as Movement[]) {
    const k = m.sku.toUpperCase();
    bySku.set(k, [...(bySku.get(k) ?? []), m]);
  }
  const drift: { sku: string; cached: number; ledger: number; lastReset: string | null; recent: Movement[] }[] = [];
  for (const p of products ?? []) {
    const movements = bySku.get(p.sku.toUpperCase()) ?? [];
    const ledger = canonicalFromMovements(movements);
    const cached = p.current_qty ?? 0;
    if (ledger !== cached) {
      const resets = movements.filter((m) => m.reason === "reset");
      drift.push({
        sku: p.sku,
        cached,
        ledger,
        lastReset: resets.length ? resets[resets.length - 1].created_at : null,
        recent: movements.slice(-5).reverse(),
      });
    }
  }
  return { checked: (products ?? []).length, drift };
}

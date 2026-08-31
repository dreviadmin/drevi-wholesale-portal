import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalFromMovements, type Movement, type MovementReason } from "./stock-ledger-core";

export { canonicalFromMovements };
export type { Movement, MovementReason };

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

/**
 * §10.1 — order movements. Confirming an order is the commitment point, so
 * that is where stock leaves. Cancelling a confirmed order puts it back as a
 * `correction` rather than deleting history.
 *
 * Idempotency is the caller's job: pass only on a real status TRANSITION, so
 * re-saving the same status never double-counts.
 */
export async function postOrderMovements(
  orderId: string,
  direction: "out" | "back",
  actor: string | null,
): Promise<{ ok: boolean; lines: number; error?: string }> {
  const admin = createAdminClient();
  const { data: order } = await admin.from("orders").select("id, order_number, items, lines_rev").eq("id", orderId).maybeSingle();
  if (!order) return { ok: false, lines: 0, error: "Order not found" };

  // Line-level billing (18 Aug): stock_moved marks a line whose stock is
  // already OUT for this order — set by whichever path moved it (a line
  // confirm or this whole-order confirm), cleared when it returns. Keying both
  // paths off the same flag means they can never double-move a line. Lines
  // explicitly on hold stay on the shelf through a whole-order confirm.
  const items = (order.items ?? []) as {
    sku?: string; qty?: number; custom?: boolean;
    line_state?: string | null; stock_moved?: boolean;
  }[];
  let lines = 0;
  const movedIdx: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Custom items are not catalog SKUs and hold no stock.
    if (!it.sku || it.custom) continue;
    const qty = Math.trunc(Number(it.qty) || 0);
    if (qty <= 0) continue;
    if (direction === "out") {
      if (it.stock_moved) continue;            // already left at line confirm
      if (it.line_state === "hold") continue;  // held lines don't ship
    } else {
      if (!it.stock_moved) continue;           // never left — nothing to return
    }
    const res = await applyMovement({
      sku: it.sku,
      delta: direction === "out" ? -qty : qty,
      reason: direction === "out" ? "order" : "correction",
      refType: "order",
      refId: orderId,
      note: direction === "out" ? `Order ${order.order_number} confirmed` : `Order ${order.order_number} cancelled — stock returned`,
      createdBy: actor ?? undefined,
    });
    if (res.ok) { lines++; movedIdx.push(i); }
  }
  if (movedIdx.length > 0) {
    // Merge the flags onto a FRESH read, CAS-guarded on lines_rev so a
    // concurrent line-state write isn't clobbered. The movements are already
    // posted, so the flags MUST land — after three lost races, write anyway
    // (a lost hold note is recoverable; a lost stock flag corrupts inventory).
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: fresh } = await admin.from("orders").select("items, lines_rev").eq("id", orderId).maybeSingle();
      const freshItems = ((fresh?.items ?? items) as typeof items);
      for (const i of movedIdx) {
        if (!freshItems[i]) continue;
        freshItems[i].stock_moved = direction === "out";
        // A whole-order confirm absorbs explicitly-pending lines (holds were
        // skipped above) — clear the marker so the chip reads confirmed.
        if (direction === "out" && freshItems[i].line_state === "pending") freshItems[i].line_state = null;
      }
      const rev = Number(fresh?.lines_rev) || 0;
      let q = admin.from("orders").update({ items: freshItems, lines_rev: rev + 1 }).eq("id", orderId);
      if (attempt < 3) q = q.eq("lines_rev", rev);
      const { data: won } = await q.select("id").maybeSingle();
      if (won) break;
    }
  }
  return { ok: true, lines };
}

/**
 * §10.2a — the single-SKU stock declaration. An absolute counted quantity that
 * SUPERSEDES earlier receipt-derived arithmetic for this SKU: nothing is
 * deleted, but the canonical calculation restarts here.
 */
export async function setStock(input: {
  sku: string;
  countedQty: number;
  note: string;
  createdBy: string;
  refType?: string;
  refId?: string;
}): Promise<{ ok: boolean; error?: string; stock?: number }> {
  if (!input.note.trim()) return { ok: false, error: "A reset needs a note — say what was counted and why" };
  if (!Number.isFinite(input.countedQty) || input.countedQty < 0) return { ok: false, error: "Counted quantity must be zero or more" };
  return applyMovement({
    sku: input.sku,
    snapshotQty: Math.trunc(input.countedQty),
    reason: "reset",
    note: input.note.trim(),
    createdBy: input.createdBy,
    refType: input.refType,
    refId: input.refId,
  });
}

/**
 * §10.2b — commit a stock take: one reset per COUNTED sku, sharing a session
 * note. Uncounted SKUs are left completely untouched; a partial stock take is
 * normal and must never zero anything by omission.
 */
export async function commitStockTake(input: {
  counts: { sku: string; countedQty: number }[];
  sessionNote: string;
  createdBy: string;
}): Promise<{ ok: boolean; committed: number; failed: { sku: string; error: string }[] }> {
  const failed: { sku: string; error: string }[] = [];
  let committed = 0;
  for (const c of input.counts) {
    const res = await setStock({
      sku: c.sku,
      countedQty: c.countedQty,
      note: input.sessionNote,
      createdBy: input.createdBy,
      refType: "stock_take",
    });
    if (res.ok) committed++;
    else failed.push({ sku: c.sku, error: res.error ?? "failed" });
  }
  return { ok: failed.length === 0, committed, failed };
}

/** §10.3 — recompute the cached column from the ledger, no new movement. */
export async function recomputeCache(sku: string): Promise<{ ok: boolean; stock: number }> {
  const admin = createAdminClient();
  const stock = await canonicalStock(sku);
  await admin.from("wholesale_products").update({ current_qty: stock }).eq("sku", sku.trim().toUpperCase());
  return { ok: true, stock };
}

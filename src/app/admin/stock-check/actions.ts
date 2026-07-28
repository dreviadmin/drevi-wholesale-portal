"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { writeAuditEvent } from "@/lib/audit";
import { recomputeCache, setStock } from "@/lib/stock-ledger";

// Retrofit R8 §10.3 — the two actions every drift row offers.
// Corrections are always logged movements, never silent overwrites.

type Res = { ok: boolean; error?: string; stock?: number };

/** The cache was stale — recompute it from the ledger. No new movement. */
export async function recomputeSku(sku: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const res = await recomputeCache(sku);
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `stock cache recomputed for ${sku} → ${res.stock}` });
  revalidatePath("/admin/stock-check");
  return { ok: true, stock: res.stock };
}

/** Reality differs — declare the counted quantity. Writes a `reset` movement. */
export async function setStockFromDrift(sku: string, countedQty: number, note: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const res = await setStock({ sku, countedQty, note, createdBy: staff.email, refType: "drift_report" });
  if (!res.ok) return { ok: false, error: res.error };
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `stock reset ${sku} → ${countedQty} from drift report (${note})` });
  revalidatePath("/admin/stock-check");
  return { ok: true, stock: res.stock };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { commitStockTake } from "@/lib/stock-ledger";

// Retrofit R8 §10.2b — stock take. Scan a tag, type the counted quantity,
// next. Commit writes ONE `reset` per counted SKU sharing a session note.
// Uncounted SKUs are left completely untouched: a partial stock take is normal
// and must never zero anything by omission.
//
// Bulk count (14 Sep) — the picker stages many SKUs at once, so commitCount is
// now called once per CHUNK rather than once per take. It was already shaped
// for that (an arbitrary array in, a per-SKU failure list out); the only
// addition is the batch marker, so the audit trail reads as one take that
// arrived in pieces rather than ten separate stock takes.

type Res = { ok: boolean; error?: string };

export interface ScannedSku {
  sku: string;
  title: string | null;
  systemQty: number;
  thumb: string | null;
  location: string | null;
}

/**
 * A catalog row for the bulk picker, in EXACTLY the shape a scanned line takes,
 * so a SKU staged from the picker and the same SKU scanned off the rack are
 * indistinguishable once they are on the count list. `category` is extra only
 * because the picker's search matches on it. Loaded in page.tsx.
 */
export interface CountableProduct extends ScannedSku {
  category: string | null;
}

/** Resolve a scanned tag to the SKU and the quantity the system currently believes. */
export async function lookupSku(raw: string): Promise<{ ok: boolean; error?: string; item?: ScannedSku }> {
  try { await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const sku = raw.trim().toUpperCase();
  if (!sku) return { ok: false, error: "Empty scan" };
  const admin = createAdminClient();
  const { data } = await admin
    .from("wholesale_products")
    .select("sku, title, current_qty, image_urls, location")
    .eq("sku", sku)
    .maybeSingle();
  if (!data) return { ok: false, error: `${sku} is not in the catalog` };
  return {
    ok: true,
    item: {
      sku: data.sku,
      title: data.title,
      systemQty: Number(data.current_qty) || 0,
      thumb: (data.image_urls as string[] | null)?.[0] ?? null,
      location: data.location ?? null,
    },
  };
}

export async function commitCount(
  counts: { sku: string; countedQty: number }[],
  sessionNote: string,
  batch?: { index: number; total: number },
): Promise<Res & { committed?: number; failed?: { sku: string; error: string }[] }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const clean = counts.filter((c) => c.sku && Number.isFinite(c.countedQty) && c.countedQty >= 0);
  if (clean.length === 0) return { ok: false, error: "Nothing counted yet" };
  const note = sessionNote.trim() || `Stock take ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;

  const res = await commitStockTake({ counts: clean, sessionNote: note, createdBy: staff.email });
  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes: `stock take committed — ${res.committed} SKU(s) reset${batch && batch.total > 1 ? ` · batch ${batch.index}/${batch.total}` : ""} · ${note}`,
  });
  revalidatePath("/admin/stock-take");
  revalidatePath("/admin/dashboard");
  return { ok: res.ok, committed: res.committed, failed: res.failed, error: res.failed.length ? `${res.failed.length} SKU(s) failed` : undefined };
}

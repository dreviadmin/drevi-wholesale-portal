"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import type { SupplyBlock } from "@/app/admin/receipts/new/delivery-actions";

// Retrofit R4 §6.2 — the specs view writes descriptive fields and the supply
// block ONLY. It can never touch pricing, cost or vendor cost data.

export async function saveSpecsAndSupply(
  designId: string,
  input: { fabric: string; handwork: string; origin: string; specsVerified: boolean; supply: SupplyBlock },
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const admin = createAdminClient();

  const patch: Record<string, unknown> = {
    fabric: input.fabric.trim() || null,
    handwork: input.handwork.trim() || null,
    origin: input.origin.trim() || null,
    specs_verified: input.specsVerified,
    updated_at: new Date().toISOString(),
  };

  // §5.9 write rule applies here too: only supplied fields overwrite.
  const s = input.supply ?? {};
  const supplyTouched =
    !!s.supplyMode || s.vendorStockQty != null || s.makingDays != null ||
    s.makingMoq != null || s.deliveryDays != null || !!s.supplyNote?.trim();
  if (s.supplyMode) patch.supply_mode = s.supplyMode;
  if (s.vendorStockQty != null) patch.vendor_stock_qty = s.vendorStockQty;
  if (s.makingDays != null) patch.making_days = s.makingDays;
  if (s.makingMoq != null) patch.making_moq = s.makingMoq;
  if (s.deliveryDays != null) patch.delivery_days = s.deliveryDays;
  if (s.supplyNote?.trim()) patch.supply_note = s.supplyNote.trim();
  if (supplyTouched) {
    patch.supply_updated_at = new Date().toISOString();
    patch.supply_updated_by = staff.email;
  }

  const { error } = await admin.from("designs").update(patch).eq("id", designId);
  if (error) return { ok: false, error: error.message };

  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes: `specs view ${designId} (verified=${input.specsVerified}${supplyTouched ? ", supply updated" : ""})`,
  });
  revalidatePath(`/admin/specs/${designId}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";

// Product Master editor actions (build guide §12.1). Every save is admin+,
// audit-logged, and — during the transition — writes ONLY to app-owned
// columns (designs.*) or sheet-synced columns WITH a lock, so the 10-minute
// sync can never silently undo an editor decision.

type Res = { ok: boolean; error?: string };
const fail = (error: string): Res => ({ ok: false, error });

// Nearest-₹99 price point (guide: cost × tier multiplier → …99).
function to99(n: number): number {
  return Math.max(99, Math.round(n / 100) * 100 - 1);
}

export async function saveSpecs(
  designId: string,
  patch: { fabric: string; handwork: string; origin: string; specsVerified: boolean },
): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { error } = await admin
    .from("designs")
    .update({
      fabric: patch.fabric || null,
      handwork: patch.handwork || null,
      origin: patch.origin || null,
      specs_verified: patch.specsVerified,
      updated_at: new Date().toISOString(),
    })
    .eq("id", designId);
  if (error) return fail(error.message);
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `master specs ${designId} (verified=${patch.specsVerified})` });
  revalidatePath(`/admin/studio/master/${designId}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

export async function savePricing(
  designId: string,
  patch: { markupMultiplier: number; mrpOverride: number | null },
): Promise<Res & { autoMrp?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const mult = Math.min(10, Math.max(1, patch.markupMultiplier || 2.5));

  // auto-MRP recomputes from the freshest cost (receipts beat the sheet).
  const { data: design } = await admin.from("designs").select("base_sku, color").eq("id", designId).maybeSingle();
  if (!design) return fail("Design not found");
  const { data: variants } = await admin.from("wholesale_products").select("sku").like("sku", `${design.base_sku}-%`);
  const skus = (variants ?? []).filter((v) => v.sku.toUpperCase().endsWith(`-${design.color}`)).map((v) => v.sku);
  let cost = 0;
  if (skus.length) {
    const { data: pvi } = await admin.from("product_vendor_info").select("last_cost").in("sku", skus);
    cost = Math.max(0, ...(pvi ?? []).map((p) => Number(p.last_cost) || 0));
  }
  const autoMrp = cost > 0 ? to99(cost * mult) : null;

  const { error } = await admin
    .from("designs")
    .update({
      markup_multiplier: mult,
      auto_mrp: autoMrp,
      mrp_override: patch.mrpOverride && patch.mrpOverride > 0 ? patch.mrpOverride : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", designId);
  if (error) return fail(error.message);
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `master pricing ${designId} mult=${mult} override=${patch.mrpOverride ?? "—"} auto=${autoMrp ?? "—"}` });
  revalidatePath(`/admin/studio/master/${designId}`);
  return { ok: true, autoMrp: autoMrp ?? undefined };
}

// Size-level: stock + wholesale price per variant. Sheet-synced columns, so
// each save LOCKS the field (existing manual-edit machinery).
export async function saveVariant(
  sku: string,
  patch: { currentQty: number; wholesalePrice: number },
): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: row } = await admin.from("wholesale_products").select("locked_fields").eq("sku", sku).maybeSingle();
  if (!row) return fail("Variant not found");
  const locks = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
  locks.add("current_qty");
  locks.add("wholesale_price");
  const { error } = await admin
    .from("wholesale_products")
    .update({
      current_qty: Math.max(0, Math.floor(patch.currentQty)),
      wholesale_price: Math.max(0, patch.wholesalePrice),
      locked_fields: [...locks],
    })
    .eq("sku", sku);
  if (error) return fail(error.message);
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `master variant ${sku} qty=${patch.currentQty} ws=${patch.wholesalePrice}` });
  revalidatePath("/admin/studio");
  return { ok: true };
}

export async function togglePortal(designId: string, portal: "wholesale" | "shopify", enabled: boolean): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { error } = await admin.from("publish_targets").update({ enabled }).eq("design_id", designId).eq("portal", portal);
  if (error) return fail(error.message);
  await writeAuditEvent({ eventType: "studio_portal_toggled", staffUserId: staff.id, notes: `${portal} ${enabled ? "enabled" : "disabled"} on design ${designId} (master editor)` });
  revalidatePath(`/admin/studio/master/${designId}`);
  revalidatePath(`/admin/studio/${designId}`);
  return { ok: true };
}

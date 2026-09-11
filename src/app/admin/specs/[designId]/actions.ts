"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import type { SupplyBlock } from "@/app/admin/receipts/new/delivery-actions";

// Retrofit R4 §6.2 — the specs view writes descriptive fields and the supply
// block, plus (11 Sep, docs/DECISIONS.md) ONE buyer-visible wholesale price
// for every size of the design. It can never touch cost, MRP or vendor cost.
//
// The price is stored per size SKU (wholesale_products.wholesale_price — the
// same column the Product Master and Manage Catalog write), so this is a
// group writer: every variant of base_sku+colour gets the value. Each row is
// updated on its own because locked_fields is per row and the sheet sync
// (ON until ANSH-07) reverts any unlocked write within ~10 minutes.

export async function saveSpecsAndSupply(
  designId: string,
  input: { fabric: string; handwork: string; origin: string; colorName?: string; specsVerified: boolean; supply: SupplyBlock; wholesalePrice?: number | null },
): Promise<{ ok: boolean; error?: string; partial?: boolean }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const admin = createAdminClient();

  // Blank/absent = no-op (never write 0). Validate before any write so an
  // invalid price cannot leave the specs half-saved.
  let price: number | null = null;
  if (input.wholesalePrice != null) {
    const p = Number(input.wholesalePrice);
    if (!Number.isFinite(p) || p < 0) return { ok: false, error: "Wholesale price must be a number ≥ 0" };
    price = Math.round(p * 100) / 100;
  }

  const patch: Record<string, unknown> = {
    fabric: input.fabric.trim() || null,
    handwork: input.handwork.trim() || null,
    origin: input.origin.trim() || null,
    // The human colour ("Champagne Gold") beside the SKU code — copy and
    // generation prompts read it (Ansh, 3 Sep).
    color_name: input.colorName?.trim() || null,
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

  let priceNote = "";
  if (price != null) {
    const r = await writeGroupPrice(admin, designId, price);
    if (!r.ok) {
      await writeAuditEvent({
        eventType: "catalog_edit",
        staffUserId: staff.id,
        notes: `specs view ${designId} (verified=${input.specsVerified}${supplyTouched ? ", supply updated" : ""}; price failed: ${r.error})`,
      });
      revalidatePath(`/admin/specs/${designId}`);
      revalidatePath("/admin/studio");
      return { ok: false, partial: true, error: `Specs saved, but price failed: ${r.error}` };
    }
    priceNote = `, ws=₹${price} on ${r.count} variant(s)`;
    revalidatePath(`/admin/studio/${designId}`);
    revalidatePath(`/admin/studio/master/${designId}`);
    revalidatePath("/admin/manage-catalog");
    revalidatePath("/catalog");
  }

  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes: `specs view ${designId} (verified=${input.specsVerified}${supplyTouched ? ", supply updated" : ""}${priceNote})`,
  });
  revalidatePath(`/admin/specs/${designId}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

async function writeGroupPrice(
  admin: ReturnType<typeof createAdminClient>,
  designId: string,
  price: number,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const { data: design } = await admin.from("designs").select("base_sku, color").eq("id", designId).maybeSingle();
  if (!design) return { ok: false, error: "Design not found" };
  const { data: variants, error: loadErr } = await admin
    .from("wholesale_products")
    .select("sku, wholesale_price, locked_fields")
    .like("sku", `${design.base_sku}-%`);
  if (loadErr) return { ok: false, error: loadErr.message };
  // `like` also matches sibling colours of the same base — filter on the suffix, upper-case both sides.
  const suffix = `-${String(design.color).toUpperCase()}`;
  const mine = (variants ?? []).filter((v) => v.sku.toUpperCase().endsWith(suffix));
  if (mine.length === 0) return { ok: false, error: "No size variants yet — log a delivery first" };

  for (const v of mine) {
    const locks = new Set<string>(Array.isArray(v.locked_fields) ? v.locked_fields : []);
    // Rows already at this value AND locked need nothing; an unlocked match
    // still gets the lock, or the sheet sync could move it later.
    if (Number(v.wholesale_price) === price && locks.has("wholesale_price")) continue;
    locks.add("wholesale_price");
    const { error } = await admin
      .from("wholesale_products")
      .update({ wholesale_price: price, locked_fields: [...locks] })
      .eq("sku", v.sku);
    if (error) return { ok: false, error: `${v.sku}: ${error.message}` };
  }
  return { ok: true, count: mine.length };
}

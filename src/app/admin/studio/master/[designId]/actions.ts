"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { applyMovement, setStock } from "@/lib/stock-ledger";
import type { SupplyBlock } from "@/app/admin/receipts/new/delivery-actions";

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
  patch: { fabric: string; handwork: string; origin: string; colorName?: string; specsVerified: boolean; supply?: SupplyBlock },
): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();

  const update: Record<string, unknown> = {
    fabric: patch.fabric || null,
    handwork: patch.handwork || null,
    origin: patch.origin || null,
    // The human colour ("Champagne Gold") beside the SKU code — the copy and
    // image prompts read it (Ansh, 3 Sep).
    color_name: patch.colorName?.trim() || null,
    specs_verified: patch.specsVerified,
    updated_at: new Date().toISOString(),
  };

  // §5.9 write rule: only fields the form actually supplied overwrite, so a
  // blank box never wipes what the delivery intake recorded.
  const s = patch.supply ?? {};
  const supplyTouched =
    !!s.supplyMode || s.vendorStockQty != null || s.makingDays != null ||
    s.makingMoq != null || s.deliveryDays != null || !!s.supplyNote?.trim();
  if (s.supplyMode) update.supply_mode = s.supplyMode;
  if (s.vendorStockQty != null) update.vendor_stock_qty = s.vendorStockQty;
  if (s.makingDays != null) update.making_days = s.makingDays;
  if (s.makingMoq != null) update.making_moq = s.makingMoq;
  if (s.deliveryDays != null) update.delivery_days = s.deliveryDays;
  if (s.supplyNote?.trim()) update.supply_note = s.supplyNote.trim();
  if (supplyTouched) {
    update.supply_updated_at = new Date().toISOString();
    update.supply_updated_by = staff.email;
  }

  const { error } = await admin.from("designs").update(update).eq("id", designId);
  if (error) return fail(error.message);
  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes: `master specs ${designId} (verified=${patch.specsVerified}${supplyTouched ? ", supply updated" : ""})`,
  });
  revalidatePath(`/admin/studio/master/${designId}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

/**
 * ONE buyer-facing wholesale price for every size of the design (Ansh, 12 Sep:
 * both prices belong in one place, beside the MRP).
 *
 * The price lives per size SKU (wholesale_products.wholesale_price — the same
 * column Manage Catalog writes), so this is a group writer. Each row is
 * updated on its own because locked_fields is per row, and the lock is what
 * stops the 10-minute sheet sync from reverting the decision.
 */
export async function setGroupWholesalePrice(designId: string, price: number): Promise<Res & { count?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  // 0 is refused: a stray "0" on a phone keypad must never unprice and lock
  // every size. Removing a price stays a per-size action below.
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return fail("Enter a price above ₹0");
  const value = Math.round(p * 100) / 100;

  const admin = createAdminClient();
  const { data: design } = await admin.from("designs").select("base_sku, color").eq("id", designId).maybeSingle();
  if (!design) return fail("Design not found");

  const { data: variants, error: loadErr } = await admin
    .from("wholesale_products")
    .select("sku, wholesale_price, locked_fields")
    .like("sku", `${design.base_sku}-%`);
  if (loadErr) return fail(loadErr.message);
  // `like` also matches sibling colours of the same base — filter on the
  // suffix, upper-casing both sides.
  const suffix = `-${String(design.color).toUpperCase()}`;
  const mine = (variants ?? []).filter((v) => v.sku.toUpperCase().endsWith(suffix));
  if (mine.length === 0) return fail("No size variants yet — log a delivery first");

  for (const v of mine) {
    const locks = new Set<string>(Array.isArray(v.locked_fields) ? v.locked_fields : []);
    // A row already at this value AND locked needs nothing; an unlocked match
    // still gets the lock, or the sheet sync could move it later.
    if (Number(v.wholesale_price) === value && locks.has("wholesale_price")) continue;
    locks.add("wholesale_price");
    const { error } = await admin
      .from("wholesale_products")
      .update({ wholesale_price: value, locked_fields: [...locks] })
      .eq("sku", v.sku);
    if (error) return fail(`${v.sku}: ${error.message}`);
  }

  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes: `master wholesale price ${designId} — ₹${value} on ${mine.length} variant(s)`,
  });
  revalidatePath(`/admin/studio/master/${designId}`);
  revalidatePath(`/admin/studio/${designId}`);
  revalidatePath("/admin/studio");
  revalidatePath("/admin/manage-catalog");
  revalidatePath("/catalog");
  return { ok: true, count: mine.length };
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
  patch: { currentQty: number; wholesalePrice: number; stockNote?: string; location?: string },
): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: row } = await admin.from("wholesale_products").select("locked_fields, current_qty").eq("sku", sku).maybeSingle();
  if (!row) return fail("Variant not found");

  // §10.1 — a manual stock edit is a MOVEMENT, not a silent overwrite, and it
  // needs a note. The price side of the save is unaffected.
  const nextQty = Math.max(0, Math.floor(patch.currentQty));
  const prevQty = Number(row.current_qty) || 0;
  const qtyChanged = nextQty !== prevQty;
  if (qtyChanged && !patch.stockNote?.trim()) {
    return fail("Changing stock needs a note — say what happened");
  }

  const locks = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
  locks.add("current_qty");
  locks.add("wholesale_price");
  const { error } = await admin
    .from("wholesale_products")
    .update({
      wholesale_price: Math.max(0, patch.wholesalePrice),
      // Physical location (2 Aug) — free text, portal-owned, never locked.
      location: patch.location?.trim() || null,
      locked_fields: [...locks],
    })
    .eq("sku", sku);
  if (error) return fail(error.message);

  if (qtyChanged) {
    const res = await applyMovement({
      sku,
      delta: nextQty - prevQty,
      reason: "manual",
      refType: "master_editor",
      note: patch.stockNote!.trim(),
      createdBy: staff.email,
    });
    if (!res.ok) return fail(res.error ?? "Could not record the stock movement");
  }
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

/**
 * §10.2a — "Set stock": declare the counted quantity for one SKU. Writes a
 * `reset` movement, which SUPERSEDES earlier receipt-derived arithmetic for
 * that SKU. Nothing is deleted; earlier movements stay as history.
 */
export async function setStockForSku(sku: string, countedQty: number, note: string): Promise<Res & { stock?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const res = await setStock({ sku, countedQty, note, createdBy: staff.email, refType: "master_editor" });
  if (!res.ok) return fail(res.error ?? "Could not set stock");
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `stock reset ${sku} → ${countedQty} (${note})` });
  revalidatePath("/admin/studio");
  return { ok: true, stock: res.stock };
}

/** Ansh (31 Jul) — one HSN for every size of this design. */
export async function saveDesignHsn(designId: string, baseSku: string, color: string, hsn: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const value = hsn.trim().slice(0, 12);
  if (value && !/^[0-9]{2,8}$/.test(value)) return fail("HSN is 2\u20138 digits.");
  const admin = createAdminClient();
  const { data: variants } = await admin.from("wholesale_products").select("sku").like("sku", `${baseSku}-%`);
  const mine = (variants ?? []).filter((v) => v.sku.toUpperCase().endsWith(`-${color.toUpperCase()}`)).map((v) => v.sku);
  if (mine.length === 0) return fail("No portal variants for this design yet.");
  const { error } = await admin.from("wholesale_products").update({ hsn: value || null }).in("sku", mine);
  if (error) return fail(error.message);
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `hsn ${value || "(cleared)"} on ${mine.length} variant(s) of ${baseSku}-${color}` });
  revalidatePath(`/admin/studio/master/${designId}`);
  return { ok: true };
}

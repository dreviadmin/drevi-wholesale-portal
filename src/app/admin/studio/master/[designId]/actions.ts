"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { applyMovement, setStock } from "@/lib/stock-ledger";
import { autoMrpFrom, autoWholesaleFrom, clampMultiplier, DEFAULT_MARKUP_MULTIPLIER, DEFAULT_WHOLESALE_MULTIPLIER } from "@/lib/pricing";
import { isOriginValue, isStyleValue } from "@/lib/studio/copy-prompt";
import type { SupplyBlock } from "@/app/admin/receipts/new/delivery-actions";

// Product Master editor actions (build guide §12.1). Every save is admin+,
// audit-logged, and — during the transition — writes ONLY to app-owned
// columns (designs.*) or sheet-synced columns WITH a lock, so the 10-minute
// sync can never silently undo an editor decision.

type Res = { ok: boolean; error?: string };
const fail = (error: string): Res => ({ ok: false, error });

type Admin = ReturnType<typeof createAdminClient>;
interface GroupRow { sku: string; wholesale_price: number | null; locked_fields: unknown }
interface VendorRow { sku: string; last_cost: number | null; locked_fields: unknown }

/**
 * The design's own size rows. `like` also matches sibling colours of the same
 * base SKU, so the suffix filter — upper-casing both sides — is what narrows
 * it to this colour.
 */
async function loadGroupRows(admin: Admin, baseSku: string, color: string): Promise<{ rows?: GroupRow[]; error?: string }> {
  const { data, error } = await admin
    .from("wholesale_products")
    .select("sku, wholesale_price, locked_fields")
    .like("sku", `${baseSku}-%`);
  if (error) return { error: error.message };
  const suffix = `-${String(color).toUpperCase()}`;
  return { rows: (data ?? []).filter((v) => v.sku.toUpperCase().endsWith(suffix)) };
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
async function writeGroupWholesale(admin: Admin, rows: GroupRow[], value: number): Promise<Res> {
  for (const v of rows) {
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
  return { ok: true };
}

/**
 * The cost, typed by hand, onto every size of the design (Ansh, 20 Sep: "at
 * time of entering the delivery, Ayushi at times does not know the prices",
 * so the figure both autos stand on has to be fixable afterwards).
 *
 * A group writer for the same reason writeGroupWholesale is —
 * product_vendor_info is keyed per size SKU — and it LOCKS last_cost (0055),
 * because sync.ts rewrites that column from the sheet every ten minutes and
 * 213 of the 281 live designs are sheet-born. Unlocked, the number would be
 * gone before anyone looked at it again.
 *
 * Upsert, not update: a size that has never been received and never appeared
 * in the sheet has no vendor row at all. Existing locks are read first and
 * merged — a blind upsert would erase whatever else the row had locked.
 */
async function writeGroupCost(admin: Admin, skus: string[], existing: VendorRow[], value: number): Promise<Res> {
  const bySku = new Map(existing.map((r) => [r.sku, r]));
  const nowIso = new Date().toISOString();
  const payload = skus.map((sku) => {
    const locks = new Set<string>(Array.isArray(bySku.get(sku)?.locked_fields) ? (bySku.get(sku)!.locked_fields as string[]) : []);
    locks.add("last_cost");
    return { sku, last_cost: value, locked_fields: [...locks], updated_at: nowIso };
  });
  // Every row carries both columns, so the bulk upsert has nothing to unify —
  // and the columns it omits (vendor_name, last_receipt_date…) are left alone
  // on an existing row rather than nulled.
  const { error } = await admin.from("product_vendor_info").upsert(payload, { onConflict: "sku" });
  return error ? fail(error.message) : { ok: true };
}

export async function saveSpecs(
  designId: string,
  patch: { fabric: string; handwork: string; origin: string; style?: string; colorName?: string; specsVerified: boolean; supply?: SupplyBlock },
): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();

  const update: Record<string, unknown> = {
    fabric: patch.fabric || null,
    handwork: patch.handwork || null,
    // 0051 — origin is one of two options now, and the column has a CHECK to
    // match. Anything else is a stale draft from before the dropdown and is
    // stored as "not set" rather than failing the whole specs save.
    origin: isOriginValue(patch.origin) ? patch.origin : null,
    // 0069 — Traditional / Indo-Western, same two-token contract as origin.
    style: isStyleValue(patch.style) ? patch.style : null,
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
 * Both prices of the design, in one save (Ansh, 12 Sep: both prices belong in
 * one place; 14 Sep: the wholesale gets the multiplier and override the MRP
 * has had since 0020, "so that one does not have to calculate manually").
 *
 * The two halves do NOT end in the same place. Retail stops at
 * designs.auto_mrp / mrp_override — nothing downstream reads a portal MRP yet.
 * The effective wholesale IS the buyer price, so it flows on to
 * wholesale_products.wholesale_price for every size of the design, locked
 * against the 10-minute sheet sync.
 *
 * Both autos recompute from the freshest cost (receipts beat the sheet), and
 * that base — product_vendor_info.last_cost — is the third thing this form
 * saves since 20 Sep. A delivery is often logged before anyone knows the
 * price, and a zero cost makes BOTH autos null, so the cost is typed here and
 * LOCKED (0055) against the ten-minute sheet sync. Left blank or unchanged it
 * is not written at all, and a real goods receipt can still move it later.
 */
export async function savePricing(
  designId: string,
  patch: { markupMultiplier: number; mrpOverride: number | null; wholesaleMultiplier: number; wholesaleOverride: number | null; lastCost?: number | null },
): Promise<Res & { autoMrp?: number; autoWholesale?: number; count?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const mult = clampMultiplier(patch.markupMultiplier, DEFAULT_MARKUP_MULTIPLIER);
  const wsMult = clampMultiplier(patch.wholesaleMultiplier, DEFAULT_WHOLESALE_MULTIPLIER);

  const { data: design } = await admin.from("designs").select("base_sku, color").eq("id", designId).maybeSingle();
  if (!design) return fail("Design not found");
  const { rows, error: rowsErr } = await loadGroupRows(admin, design.base_sku, design.color);
  if (rowsErr || !rows) return fail(rowsErr ?? "Could not read the size variants");
  let vendorRows: VendorRow[] = [];
  // 42703 = locked_fields is not on this database yet (0055 unapplied). The
  // deploy can legitimately land before the migration, and when it does the
  // whole pricing card must keep working — a multiplier save has nothing to
  // do with the cost column. So: retry the read without the lock column, and
  // refuse ONLY the cost further down. sync.ts:435 takes the same escape for
  // the same reason.
  let locksAvailable = true;
  if (rows.length) {
    const skuList = rows.map((v) => v.sku);
    const withLocks = await admin.from("product_vendor_info").select("sku, last_cost, locked_fields").in("sku", skuList);
    if (withLocks.error?.code === "42703") {
      locksAvailable = false;
      const plain = await admin.from("product_vendor_info").select("sku, last_cost").in("sku", skuList);
      // The cost is a WRITE target now, not just a number to read: guessing 0
      // on a failed read would republish both autos as "needs a cost".
      if (plain.error) return fail(`Could not read the cost: ${plain.error.message}`);
      vendorRows = (plain.data ?? []) as VendorRow[];
    } else if (withLocks.error) {
      return fail(`Could not read the cost: ${withLocks.error.message}`);
    } else {
      vendorRows = withLocks.data ?? [];
    }
  }
  // 0 is refused on the cost exactly as on the two overrides below — a stray
  // "0" on a phone keypad must not blank the base both prices stand on.
  const typedCost = patch.lastCost && patch.lastCost > 0 ? patch.lastCost : null;
  if (typedCost != null && rows.length === 0) {
    return fail("No size variants yet — log a delivery before setting a cost.");
  }
  // Writing a cost without somewhere to record the lock would leave it at the
  // sheet's mercy — the next sync would quietly undo it. Refuse the cost, not
  // the save: the multipliers and overrides below still go through.
  if (typedCost != null && !locksAvailable) {
    return fail("Cost cannot be set until migration 0055 is applied — the multipliers saved, the cost did not.");
  }
  const cost = typedCost ?? Math.max(0, ...vendorRows.map((p) => Number(p.last_cost) || 0));
  const autoMrp = autoMrpFrom(cost, mult);
  const autoWholesale = autoWholesaleFrom(cost, wsMult);
  // 0 is refused on both overrides: a stray "0" on a phone keypad must never
  // unprice and lock every size. Removing a price stays a per-size action.
  const mrpOverride = patch.mrpOverride && patch.mrpOverride > 0 ? patch.mrpOverride : null;
  const wsOverride = patch.wholesaleOverride && patch.wholesaleOverride > 0 ? patch.wholesaleOverride : null;
  const effectiveWholesale = wsOverride ?? autoWholesale;

  // The cost lands BEFORE the design row, so a design never carries autos
  // computed from a cost that failed to save.
  if (typedCost != null) {
    const res = await writeGroupCost(admin, rows.map((v) => v.sku), vendorRows, typedCost);
    if (!res.ok) return res;
  }

  const { error } = await admin
    .from("designs")
    .update({
      markup_multiplier: mult,
      auto_mrp: autoMrp,
      mrp_override: mrpOverride,
      wholesale_multiplier: wsMult,
      auto_wholesale: autoWholesale,
      wholesale_override: wsOverride,
      updated_at: new Date().toISOString(),
    })
    .eq("id", designId);
  if (error) return fail(error.message);

  // A design whose sizes are deliberately priced apart is NOT flattened by a
  // save that never named a wholesale price — someone nudging the MRP
  // multiplier must not silently collapse that spread onto cost × 1.2. Only
  // an explicit override, or a group that already agrees on one price, may
  // write one number onto every size.
  const uniform = rows.every((v) => Number(v.wholesale_price) === Number(rows[0].wholesale_price));
  let count = 0;
  if (rows.length > 0 && effectiveWholesale && (wsOverride != null || uniform)) {
    const value = Math.round(effectiveWholesale * 100) / 100;
    const res = await writeGroupWholesale(admin, rows, value);
    if (!res.ok) return res;
    count = rows.length;
  }

  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes:
      // The cost is named first because it moves both autos — a later reader
      // asking "why did this design reprice?" should see it without digging.
      `master pricing ${designId} — cost ${typedCost != null ? `₹${typedCost} set by hand + locked on ${rows.length} size(s)` : `₹${cost || "—"} (unchanged)`}; ` +
      `mrp mult=${mult} override=${mrpOverride ?? "—"} auto=${autoMrp ?? "—"}; ` +
      `wholesale mult=${wsMult} override=${wsOverride ?? "—"} auto=${autoWholesale ?? "—"} → ₹${effectiveWholesale ?? "—"} on ${count} variant(s)`,
  });
  revalidatePath(`/admin/studio/master/${designId}`);
  revalidatePath(`/admin/studio/${designId}`);
  revalidatePath("/admin/studio");
  revalidatePath("/admin/manage-catalog");
  revalidatePath("/catalog");
  return { ok: true, autoMrp: autoMrp ?? undefined, autoWholesale: autoWholesale ?? undefined, count };
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

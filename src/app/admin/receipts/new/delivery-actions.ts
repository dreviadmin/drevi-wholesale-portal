"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { ALL_ANGLES } from "@/lib/studio/state";
import { applyMovement } from "@/lib/stock-ledger";
import { ensureDesignFolder, uploadDesignImage, uploadsEnabled, UPLOADS_DISABLED_MESSAGE } from "@/lib/drive-design";

// Retrofit R3 (§5) — "Log delivery": one screen, one motion per garment.
//
// The unit of work is the GARMENT, not the receipt line: one captured garment
// = one design group = N receipt lines (one per size). The design group, ident
// photo, supply block and vendor SKU are captured once and shared by every
// line (§5.4).

export interface SizeQty { size: string; qty: number }

export interface SupplyBlock {
  supplyMode?: "ready_stock" | "made_to_order" | "both" | "discontinued" | "";
  vendorStockQty?: number | null;
  makingDays?: number | null;
  makingMoq?: number | null;
  deliveryDays?: number | null;
  supplyNote?: string;
}

export interface GarmentInput {
  /** existing design (reorder path) */
  designId?: string;
  /** new design: mint from these */
  cat?: string;
  sub?: string;
  color?: string;
  /** resolved/base SKU for a reorder */
  baseSku?: string;
  description?: string;
  vendorSku?: string;
  unitCost: number;
  sizes: SizeQty[];
  supply?: SupplyBlock;
  /** ident photo, already uploaded via uploadIdentPhoto → design_images id */
  identImageId?: string;
}

export interface DeliveryInput {
  vendorId: string;
  receiptDate?: string;
  billAmount?: number | null;
  notes?: string;
  clientRef?: string;
  garments: GarmentInput[];
}

type Res = { ok: boolean; error?: string };
const fail = (error: string): Res => ({ ok: false, error });

function istToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// §5.9 — only supplied fields overwrite; blanks never wipe existing values.
function supplyPatch(s: SupplyBlock | undefined, staffEmail: string): Record<string, unknown> {
  if (!s) return {};
  const patch: Record<string, unknown> = {};
  if (s.supplyMode) patch.supply_mode = s.supplyMode;
  if (s.vendorStockQty != null && s.vendorStockQty >= 0) patch.vendor_stock_qty = s.vendorStockQty;
  if (s.makingDays != null && s.makingDays >= 0) patch.making_days = s.makingDays;
  if (s.makingMoq != null && s.makingMoq > 0) patch.making_moq = s.makingMoq;
  if (s.deliveryDays != null && s.deliveryDays >= 0) patch.delivery_days = s.deliveryDays;
  if (s.supplyNote?.trim()) patch.supply_note = s.supplyNote.trim();
  if (Object.keys(patch).length > 0) {
    patch.supply_updated_at = new Date().toISOString();
    patch.supply_updated_by = staffEmail;
  }
  return patch;
}

function supplyObservation(s: SupplyBlock | undefined): Record<string, unknown> {
  if (!s) return {};
  return {
    supply_mode: s.supplyMode || null,
    vendor_stock_qty: s.vendorStockQty ?? null,
    making_days: s.makingDays ?? null,
    making_moq: s.makingMoq ?? null,
    delivery_days: s.deliveryDays ?? null,
    supply_note: s.supplyNote?.trim() || null,
  };
}

/** Mint one variant SKU through the existing RPC (floor rules unchanged). */
async function mintSku(
  mode: "new" | "variant",
  opts: { cat?: string; sub?: string; baseSku?: string; color: string; size: string; description: string; staffEmail: string },
): Promise<{ ok: true; baseSku: string; variantSku: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  // Floors: product tables + retail master + (dual mode) the registry sheet.
  let floor = 0;
  const warnings: string[] = [];
  if (mode === "new" && opts.cat && opts.sub) {
    const { knownSkuFloor, masterNumberFloor, sheetNumberFloor, dualMode } = await import("@/lib/sku/registry-sheet");
    const [known, master, sheet] = await Promise.all([
      knownSkuFloor(opts.cat, opts.sub),
      masterNumberFloor(opts.cat, opts.sub),
      dualMode() ? sheetNumberFloor(opts.cat, opts.sub) : Promise.resolve({ floor: 0, warning: undefined as string | undefined }),
    ]);
    floor = Math.max(known, master.floor, sheet.floor);
    if (master.warning) warnings.push(master.warning);
    if (sheet.warning) warnings.push(sheet.warning);
  }
  const { data, error } = await admin.rpc("generate_sku", {
    p_mode: mode,
    p_cat: mode === "new" ? opts.cat : null,
    p_sub: mode === "new" ? opts.sub : null,
    p_base_sku: mode === "variant" ? opts.baseSku : null,
    p_color: opts.color,
    p_size: opts.size,
    p_description: opts.description,
    p_created_by: opts.staffEmail,
    p_number_floor: floor,
  });
  if (error) return { ok: false, error: error.message };
  const r = data as { base_sku: string; variant_sku: string };
  // §5.12 write-through: best effort, never blocks the mint.
  try {
    const { mirrorOne } = await import("@/lib/sku/registry-sheet");
    await mirrorOne(r.variant_sku);
  } catch { /* cron retries; UI shows "registry sync pending" */ }
  return { ok: true, baseSku: r.base_sku, variantSku: r.variant_sku };
}

/**
 * Upload the ident photo for a garment (§5.3b). Called from the capture sheet
 * BEFORE save so the operator sees the photo bound to the SKU immediately.
 * Requires an existing design (reorder) or a freshly minted one.
 */
export async function uploadIdentPhoto(
  designId: string,
  formData: FormData,
): Promise<{ ok: boolean; error?: string; imageId?: string; fileRef?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  if (!uploadsEnabled()) return fail(UPLOADS_DISABLED_MESSAGE);
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return fail("No photo");

  const admin = createAdminClient();
  const { data: design } = await admin.from("designs").select("id, base_sku, color, drive_folder_id, ident_image_id").eq("id", designId).maybeSingle();
  if (!design) return fail("Design not found");

  let folderId = design.drive_folder_id;
  if (!folderId) {
    const match = await ensureDesignFolder(design.base_sku, design.color);
    if (!match.folderId) {
      return fail(match.rule === "ambiguous" ? "Several Drive folders match this design — resolve in the folder audit." : UPLOADS_DISABLED_MESSAGE);
    }
    folderId = match.folderId;
    await admin.from("designs").update({ drive_folder_id: folderId }).eq("id", designId);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const up = await uploadDesignImage(folderId, bytes, file.type || "image/jpeg", "ident.jpg", { archivePrevious: !!design.ident_image_id });
  const { data: row, error } = await admin
    .from("design_images")
    .insert({
      design_id: designId,
      role: "ident",
      file_ref: up.fileId,
      file_name: up.fileName,
      status: "active",
      created_by: staff.email,
    })
    .select("id")
    .single();
  if (error) return fail(error.message);
  // Previous ident row is archived, never deleted (§4.5).
  if (design.ident_image_id) await admin.from("design_images").update({ status: "archived" }).eq("id", design.ident_image_id);
  await admin.from("designs").update({ ident_image_id: row.id }).eq("id", designId);
  return { ok: true, imageId: row.id, fileRef: up.fileId };
}

/**
 * Mint (or resolve) the design group for one garment so the capture sheet can
 * bind a photo to a real SKU before the delivery is saved (§5.3a/b).
 * Sizes drive minting: the first size mints the base, the rest are variants.
 */
export async function resolveGarmentDesign(input: {
  designId?: string;
  cat?: string;
  sub?: string;
  color?: string;
  baseSku?: string;
  description?: string;
  sizes: string[];
}): Promise<{ ok: boolean; error?: string; designId?: string; baseSku?: string; color?: string; variantSkus?: string[]; created?: boolean }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const sizes = [...new Set((input.sizes ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (sizes.length === 0) return fail("Pick at least one size");

  // Reorder path — design already exists.
  if (input.designId) {
    const { data: d } = await admin.from("designs").select("id, base_sku, color").eq("id", input.designId).maybeSingle();
    if (!d) return fail("Design not found");
    const variantSkus: string[] = [];
    for (const size of sizes) {
      const wanted = `${d.base_sku}-${size}-${d.color}`;
      const { data: existing } = await admin.from("sku_registry").select("variant_sku").ilike("variant_sku", wanted).maybeSingle();
      if (existing) { variantSkus.push(existing.variant_sku); continue; }
      const m = await mintSku("variant", { baseSku: d.base_sku, color: d.color, size, description: input.description ?? "", staffEmail: staff.email });
      if (!m.ok) return fail(m.error);
      variantSkus.push(m.variantSku);
    }
    return { ok: true, designId: d.id, baseSku: d.base_sku, color: d.color, variantSkus, created: false };
  }

  // New design — mint base from the first size, variants for the rest (§5.4).
  const cat = (input.cat ?? "").trim().toUpperCase();
  const sub = (input.sub ?? "").trim().toUpperCase();
  const color = (input.color ?? "").trim().toUpperCase();
  if (!cat || !sub || !color) return fail("Category, sub-category and colour are required");

  const first = await mintSku("new", { cat, sub, color, size: sizes[0], description: input.description ?? "", staffEmail: staff.email });
  if (!first.ok) return fail(first.error);
  const variantSkus = [first.variantSku];
  for (const size of sizes.slice(1)) {
    const m = await mintSku("variant", { baseSku: first.baseSku, color, size, description: input.description ?? "", staffEmail: staff.email });
    if (!m.ok) return fail(m.error);
    variantSkus.push(m.variantSku);
  }

  // Design group + its six angles (§5.7).
  const { data: design, error } = await admin
    .from("designs")
    .upsert({ base_sku: first.baseSku, color, origin_source: "app", title: input.description?.trim() || null, category: cat, sub_category: sub }, { onConflict: "base_sku,color" })
    .select("id")
    .single();
  if (error) return fail(error.message);
  const { data: haveAngles } = await admin.from("design_angles").select("angle").eq("design_id", design.id);
  const existing = new Set((haveAngles ?? []).map((a) => a.angle));
  const missing = ALL_ANGLES.filter((a) => !existing.has(a)).map((angle) => ({ design_id: design.id, angle }));
  if (missing.length) await admin.from("design_angles").insert(missing);
  for (const portal of ["wholesale", "shopify"]) {
    await admin.from("publish_targets").upsert({ design_id: design.id, portal }, { onConflict: "design_id,portal" });
  }
  return { ok: true, designId: design.id, baseSku: first.baseSku, color, variantSkus, created: true };
}

/** §5.7 — save the whole delivery. */
export async function saveDelivery(input: DeliveryInput): Promise<{ ok: boolean; error?: string; receiptId?: string; receiptNumber?: string; skus?: string[] }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  if (!input.vendorId) return fail("Pick a vendor");
  if (!input.garments?.length) return fail("Add at least one garment");

  // Idempotency — a double-tap resolves to the existing receipt.
  const clientRef = input.clientRef?.trim() || null;
  if (clientRef) {
    const { data: existing } = await admin.from("goods_receipts").select("id, receipt_number").eq("client_ref", clientRef).maybeSingle();
    if (existing) return { ok: true, receiptId: existing.id, receiptNumber: existing.receipt_number };
  }

  const today = istToday();
  const receiptDate = input.receiptDate?.trim() || today;
  const { data: numberData, error: numErr } = await admin.rpc("next_order_number", { p_prefix: "GR", p_day: today });
  if (numErr) return fail(`Receipt number failed: ${numErr.message}`);
  const receiptNumber = numberData as string;

  const { data: receipt, error: rErr } = await admin
    .from("goods_receipts")
    .insert({
      receipt_number: receiptNumber,
      vendor_id: input.vendorId,
      receipt_date: receiptDate,
      entry_date: today, // §3.3 immutable after insert — never patched later
      bill_amount: input.billAmount ?? null,
      notes: input.notes?.trim() || null,
      client_ref: clientRef,
      created_by: staff.email,
    })
    .select("id")
    .single();
  if (rErr) return fail(rErr.message);

  const allSkus: string[] = [];
  let position = 0;
  for (const g of input.garments) {
    if (!g.designId || !g.baseSku) return fail("A garment is missing its design — re-open the card");
    const { data: design } = await admin.from("designs").select("id, base_sku, color, first_receipt_id").eq("id", g.designId).maybeSingle();
    if (!design) return fail("Design vanished mid-save — retry");

    // Design-level: provenance, vendor, supply, ident (§5.7 / §5.9).
    const designPatch: Record<string, unknown> = {
      origin_source: "app",
      vendor_id: input.vendorId,
      ...(g.vendorSku?.trim() ? { vendor_sku: g.vendorSku.trim() } : {}),
      ...(design.first_receipt_id ? {} : { first_receipt_id: receipt.id }),
      ...supplyPatch(g.supply, staff.email),
      updated_at: new Date().toISOString(),
    };
    await admin.from("designs").update(designPatch).eq("id", g.designId);

    const observation = supplyObservation(g.supply);
    for (const s of g.sizes) {
      const size = s.size.trim().toUpperCase();
      const qty = Math.max(1, Math.floor(s.qty));
      const sku = `${design.base_sku}-${size}-${design.color}`.toUpperCase();
      allSkus.push(sku);
      const { data: line, error: lErr } = await admin
        .from("goods_receipt_lines")
        .insert({
          receipt_id: receipt.id,
          sku,
          description: g.description?.trim() || null,
          qty,
          unit_cost: Math.round((Number(g.unitCost) || 0) * 100) / 100,
          position: position++,
          vendor_sku: g.vendorSku?.trim() || null,
          design_id: g.designId,
          created_design: !!g.sizes.length && !design.first_receipt_id,
          ...observation,
        })
        .select("id")
        .single();
      if (lErr) return fail(`${sku}: ${lErr.message}`);

      // An app-born design has no catalog row yet — create one so the garment
      // exists as a product. It stays HIDDEN until Rakesh sets specs + price
      // (§6.1: receipt-created designs land at "Awaiting specs").
      const { data: existingProduct } = await admin.from("wholesale_products").select("sku").eq("sku", sku).maybeSingle();
      if (!existingProduct) {
        await admin.from("wholesale_products").insert({
          sku,
          title: g.description?.trim() || null,
          category: null,
          sub_category: null,
          color: design.color,
          wholesale_price: 0,
          wholesale_visible: false,
          current_qty: 0,
          restockable: true,
          locked_fields: ["wholesale_visible"], // sheet sync must not flip it
          synced_at: new Date().toISOString(),
        });
      }

      // §5.7 — receipts now set last_cost and INCREMENT stock, through the
      // ledger so the cache can never drift (§10.1).
      await applyMovement({
        sku,
        delta: qty,
        reason: "receipt",
        refType: "goods_receipt_line",
        refId: line.id,
        note: `${receiptNumber} · ${qty} pc`,
        createdBy: staff.email,
      });
      await admin.from("product_vendor_info").upsert(
        { sku, last_cost: Math.round((Number(g.unitCost) || 0) * 100) / 100, last_receipt_date: receiptDate, updated_at: new Date().toISOString() },
        { onConflict: "sku" },
      );
    }
  }

  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes: `delivery ${receiptNumber}: ${input.garments.length} garment(s) → ${allSkus.length} line(s)`,
  });
  revalidatePath("/admin/receipts");
  revalidatePath("/admin/studio");
  return { ok: true, receiptId: receipt.id, receiptNumber, skus: allSkus };
}

/** Inline "+ New vendor" from the delivery screen (§5.2). */
export async function quickAddVendor(name: string, phone?: string): Promise<{ ok: boolean; error?: string; id?: string; name?: string }> {
  try { await requireAdmin(); } catch { return fail("Not authorized"); }
  const clean = name.trim();
  if (!clean) return fail("Vendor name required");
  const admin = createAdminClient();
  const { data: existing } = await admin.from("vendors").select("id, name").ilike("name", clean).maybeSingle();
  if (existing) return { ok: true, id: existing.id, name: existing.name };
  const { data, error } = await admin
    .from("vendors")
    .insert({ name: clean, phone: phone?.trim() || null, active: true })
    .select("id, name")
    .single();
  if (error) return fail(error.message);
  revalidatePath("/admin/vendors");
  return { ok: true, id: data.id, name: data.name };
}

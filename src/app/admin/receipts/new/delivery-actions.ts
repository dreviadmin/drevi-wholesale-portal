"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { ALL_ANGLES } from "@/lib/studio/state";
import { BASE_SKU_RE } from "@/lib/sku/vocab";
import { validCodes } from "@/lib/sku/vocab-live";
import { applyMovement } from "@/lib/stock-ledger";
import { storeDesignImage } from "@/lib/design-image-store";
import { ensureDesignImagery } from "@/lib/design-imagery";
import { exGstCost } from "@/lib/gst";

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
  /** resolved base SKU — of a reorder, or of the base a new colour is added to */
  baseSku?: string;
  description?: string;
  vendorSku?: string;
  unitCost: number;
  /** GST classification, captured at goods-in (31 Jul). */
  hsn?: string;
  sizes: SizeQty[];
  supply?: SupplyBlock;
  /** ident photo, already uploaded via uploadIdentPhoto → design_images id */
  identImageId?: string;
}

export interface GstInput {
  mode: "kaccha" | "pakka" | null;
  rate?: number | null; // 5 | 18
  inclusive?: boolean | null;
}

export interface DeliveryInput {
  vendorId: string;
  receiptDate?: string;
  billAmount?: number | null;
  notes?: string;
  clientRef?: string;
  gst?: GstInput;
  garments: GarmentInput[];
}

/** A design group touched by a saved delivery — drives the post-save "complete product details" prompt. */
export interface SavedDesign {
  id: string;
  baseSku: string;
  color: string;
  title: string | null;
  /** this receipt is the design's first — it was born (or first stocked) here */
  created: boolean;
  specsVerified: boolean;
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
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return fail("No photo");

  const admin = createAdminClient();
  const { data: design } = await admin.from("designs").select("id, base_sku, color, drive_folder_id, ident_image_id").eq("id", designId).maybeSingle();
  if (!design) return fail("Design not found");

  // Dual backend (UX sprint): Drive when configured, portal storage otherwise.
  let up;
  try {
    up = await storeDesignImage({
      designId,
      baseSku: design.base_sku,
      color: design.color,
      angle: "design",
      kind: "ident",
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "image/jpeg",
      driveFolderId: design.drive_folder_id,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Upload failed");
  }
  if (up.driveFolderId && !design.drive_folder_id) {
    await admin.from("designs").update({ drive_folder_id: up.driveFolderId }).eq("id", designId);
  }
  const { data: row, error } = await admin
    .from("design_images")
    .insert({
      design_id: designId,
      role: "ident",
      file_ref: up.fileRef,
      file_name: up.fileName,
      status: "active",
      created_by: staff.email,
    })
    .select("id")
    .single();
  if (error) return fail(error.message);
  // Previous ident row is archived, never deleted (§4.5).
  if (design.ident_image_id) {
    const { data: prev } = await admin.from("design_images").select("id, file_ref").eq("id", design.ident_image_id).maybeSingle();
    await admin.from("design_images").update({ status: "archived" }).eq("id", design.ident_image_id);
    // A front still showing the OLD rack photo follows the re-shoot: clear it
    // so the imagery rule below re-seeds from the new ident. A real front — one
    // with its own source, or an approved image — stays put.
    const { data: front } = await admin
      .from("design_angles")
      .select("id, source_ref, source_image_id, approved_image_id")
      .eq("design_id", designId)
      .eq("angle", "front")
      .maybeSingle();
    const seededFromPrev = !!prev && (front?.source_image_id === prev.id || front?.source_ref === prev.file_ref);
    if (front && !front.approved_image_id && seededFromPrev) {
      await admin.from("design_angles").update({ source_image_id: null, source_ref: null }).eq("id", front.id);
    }
  }
  await admin.from("designs").update({ ident_image_id: row.id }).eq("id", designId);
  // The rack photo taken at delivery becomes the FRONT angle's source until a
  // real front shot exists (Ansh, 12 Sep) — the Studio then opens with
  // something to work from instead of an empty card, and the board shows the
  // garment. One shared rule now, so a Drive or Studio photo seeds it too.
  await ensureDesignImagery(admin, designId);
  return { ok: true, imageId: row.id, fileRef: up.fileRef };
}

/**
 * The design group for one (base SKU, colour): the designs row, its six angles
 * and both publish targets (§5.7). Lifted out of the new-design path (19 Sep)
 * so a colour added to an existing base is as complete a record as a design
 * born here — that completeness is exactly what the SKU generator's "variant
 * of existing" never produced.
 */
async function ensureDesignGroup(opts: {
  baseSku: string; color: string; cat: string; sub: string; title?: string;
}): Promise<{ ok: true; designId: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { data: design, error } = await admin
    .from("designs")
    .upsert({ base_sku: opts.baseSku, color: opts.color, origin_source: "app", title: opts.title?.trim() || null, category: opts.cat, sub_category: opts.sub }, { onConflict: "base_sku,color" })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  const { data: haveAngles } = await admin.from("design_angles").select("angle").eq("design_id", design.id);
  const existing = new Set((haveAngles ?? []).map((a) => a.angle));
  const missing = ALL_ANGLES.filter((a) => !existing.has(a)).map((angle) => ({ design_id: design.id, angle }));
  if (missing.length) await admin.from("design_angles").insert(missing);
  for (const portal of ["wholesale", "shopify"]) {
    await admin.from("publish_targets").upsert({ design_id: design.id, portal }, { onConflict: "design_id,portal" });
  }
  return { ok: true, designId: design.id };
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

  // New COLOUR of an existing base (19 Sep) — the third way a garment arrives.
  // DD-LEH-FLR-115 exists in GRN, the same garment turns up in RED: the number
  // stays, the colour is new. The SKU generator can already mint that variant,
  // but it writes only a sku_registry row — no designs row, no angles, no
  // publish targets, no receipt line — so the colour never reached the Studio
  // or the board. Here the mint runs with every side effect the new-design
  // path has. Ordered after the reorder branch: designId always wins.
  if (input.baseSku) {
    const baseSku = input.baseSku.trim().toUpperCase();
    const color = (input.color ?? "").trim().toUpperCase();
    if (!BASE_SKU_RE.test(baseSku)) return fail(`"${baseSku}" is not a valid base SKU`);
    if (!color) return fail("Pick the new colour");
    // Same merged vocab /api/sku/generate validates against, so a colour
    // Rakesh added in /admin/lovs mints here too.
    const { colors } = await validCodes();
    if (!colors.has(color)) return fail(`Unknown colour code "${color}"`);

    // This path extends a number that exists; it never invents one.
    const { data: registered } = await admin.from("sku_registry").select("base_sku").ilike("base_sku", baseSku).limit(1).maybeSingle();
    if (!registered) return fail(`${baseSku} is not in the registry — use New design instead`);

    // Already a design in this colour — that is the reorder path. Falling
    // through would re-stamp the group's title and category from this sheet:
    // ensureDesignGroup's upsert conflicts on (base_sku, colour) and UPDATES.
    // So the check has to fail CLOSED — an unreadable answer is not "no
    // duplicate", it is "do not touch a group we cannot see".
    const { data: dupe, error: dupeErr } = await admin.from("designs").select("id").ilike("base_sku", baseSku).ilike("color", color).maybeSingle();
    if (dupeErr) return fail(`Could not check whether ${baseSku} already exists in ${color} — retry (${dupeErr.message})`);
    if (dupe) return fail(`${baseSku} already exists in ${color} — search for that design instead of adding the colour`);

    // Category/sub follow a sibling colour of the same base when there is one;
    // the SKU segments are the fallback (the RPC derives them the same way),
    // so a base minted in the SKU generator — registry row, no design at all —
    // still lands correctly classified.
    // Inherited VERBATIM. designs.category is a display NAME on most rows
    // ("Lehenga", 215 of 279 on prod) and a CODE on the rest ("LEH") — the
    // sheet era left both shapes in the column. Upper-casing what a sibling
    // holds turns "Lehenga" into "LEHENGA", which resolves through no vocab
    // entry and reaches the Shopify metafield shouting. Only the SKU-segment
    // fallback is a real code, so only that one is upper-cased.
    const { data: sibling } = await admin.from("designs").select("category, sub_category").ilike("base_sku", baseSku).limit(1).maybeSingle();
    const inheritedCat = sibling?.category?.trim() || (baseSku.split("-")[1] ?? "").toUpperCase();
    const inheritedSub = sibling?.sub_category?.trim() || (baseSku.split("-")[2] ?? "").toUpperCase();

    // Idempotent like the reorder path: a variant already in the registry is
    // adopted, never minted twice. That also ADOPTS SKUs the SKU generator
    // minted earlier for this colour and left stranded without a design.
    const variantSkus: string[] = [];
    for (const size of sizes) {
      const wanted = `${baseSku}-${size}-${color}`;
      const { data: existing } = await admin.from("sku_registry").select("variant_sku").ilike("variant_sku", wanted).maybeSingle();
      if (existing) { variantSkus.push(existing.variant_sku); continue; }
      const m = await mintSku("variant", { baseSku, color, size, description: input.description ?? "", staffEmail: staff.email });
      if (!m.ok) return fail(m.error);
      variantSkus.push(m.variantSku);
    }

    const group = await ensureDesignGroup({ baseSku, color, cat: inheritedCat, sub: inheritedSub, title: input.description });
    if (!group.ok) return fail(group.error);
    // created: the (base, colour) group is new even though the number is not.
    return { ok: true, designId: group.designId, baseSku, color, variantSkus, created: true };
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
  const group = await ensureDesignGroup({ baseSku: first.baseSku, color, cat, sub, title: input.description });
  if (!group.ok) return fail(group.error);
  return { ok: true, designId: group.designId, baseSku: first.baseSku, color, variantSkus, created: true };
}

/**
 * Wholesale price of any already-priced sibling size in the (base_sku, colour)
 * group, else 0. The Studio gate counts a group as priced when ANY variant is,
 * so a new size seeded at ₹0 would pass the gate and then be refused by the cart.
 */
async function pricedSiblingPrice(baseSku: string, color: string): Promise<number> {
  const admin = createAdminClient();
  const prefix = `${baseSku}-`.toUpperCase();
  const suffix = `-${color}`.toUpperCase();
  const { data } = await admin.from("wholesale_products").select("sku, wholesale_price").ilike("sku", `${prefix}%${suffix}`).gt("wholesale_price", 0);
  // Inherit only when every priced size agrees; mixed per-size prices leave
  // the new size at 0 (unlocked) so the Specs page's mixed-price hint asks a
  // human instead of locking a guess.
  const seen = new Set<number>();
  for (const p of data ?? []) {
    const sku = String(p.sku).toUpperCase();
    const size = sku.slice(prefix.length, sku.length - suffix.length);
    if (sku.startsWith(prefix) && sku.endsWith(suffix) && size && !size.includes("-")) seen.add(Number(p.wholesale_price) || 0);
  }
  return seen.size === 1 ? [...seen][0] : 0;
}

/** §5.7 — save the whole delivery. */
export async function saveDelivery(input: DeliveryInput): Promise<{ ok: boolean; error?: string; receiptId?: string; receiptNumber?: string; skus?: string[]; designs?: SavedDesign[] }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  if (!input.vendorId) return fail("Pick a vendor");
  if (!input.garments?.length) return fail("Add at least one garment");

  // Idempotency — a double-tap resolves to the existing receipt.
  const clientRef = input.clientRef?.trim() || null;
  if (clientRef) {
    const { data: existing } = await admin.from("goods_receipts").select("id, receipt_number").eq("client_ref", clientRef).maybeSingle();
    if (existing) {
      // Same shape as a fresh save so a replayed "Save & print tags" still stages its tray.
      const { data: ls } = await admin.from("goods_receipt_lines").select("sku, design_id, description").eq("receipt_id", existing.id).order("position");
      const lineRows = ls ?? [];
      const ids = [...new Set(lineRows.map((l) => l.design_id).filter(Boolean))] as string[];
      const ds = ids.length ? (await admin.from("designs").select("id, base_sku, color, title, specs_verified, first_receipt_id").in("id", ids)).data ?? [] : [];
      const designs: SavedDesign[] = ds.map((d) => ({
        id: d.id,
        baseSku: d.base_sku,
        color: d.color,
        title: d.title || lineRows.find((l) => l.design_id === d.id)?.description || null,
        created: d.first_receipt_id === existing.id,
        specsVerified: !!d.specs_verified,
      }));
      return { ok: true, receiptId: existing.id, receiptNumber: existing.receipt_number, skus: lineRows.map((l) => l.sku), designs };
    }
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
      gst_mode: input.gst?.mode ?? null,
      gst_rate: input.gst?.mode === "pakka" ? input.gst?.rate ?? null : null,
      gst_inclusive: input.gst?.mode === "pakka" ? input.gst?.inclusive ?? null : null,
      notes: input.notes?.trim() || null,
      client_ref: clientRef,
      created_by: staff.email,
    })
    .select("id")
    .single();
  if (rErr) return fail(rErr.message);

  const allSkus: string[] = [];
  const savedDesigns = new Map<string, SavedDesign>();
  let position = 0;
  for (const g of input.garments) {
    if (!g.designId || !g.baseSku) return fail("A garment is missing its design — re-open the card");
    const { data: design } = await admin.from("designs").select("id, base_sku, color, title, specs_verified, first_receipt_id").eq("id", g.designId).maybeSingle();
    if (!design) return fail("Design vanished mid-save — retry");
    // Read BEFORE the update below stamps first_receipt_id — that is what "created here" means.
    if (!savedDesigns.has(design.id)) {
      savedDesigns.set(design.id, {
        id: design.id,
        baseSku: design.base_sku,
        color: design.color,
        title: design.title || g.description?.trim() || null,
        created: !design.first_receipt_id,
        specsVerified: !!design.specs_verified,
      });
    }
    // A new size on an already-priced design inherits the sibling price.
    const siblingPrice = await pricedSiblingPrice(design.base_sku, design.color);

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
      const hsnValue = g.hsn?.trim() && /^[0-9]{2,8}$/.test(g.hsn.trim()) ? g.hsn.trim() : null;
      const { data: existingProduct } = await admin.from("wholesale_products").select("sku").eq("sku", sku).maybeSingle();
      if (!existingProduct) {
        await admin.from("wholesale_products").insert({
          sku,
          hsn: hsnValue,
          title: g.description?.trim() || null,
          category: null,
          sub_category: null,
          color: design.color,
          wholesale_price: siblingPrice,
          wholesale_visible: false,
          current_qty: 0,
          restockable: true,
          // sheet sync must not flip visibility, nor overwrite an inherited price
          locked_fields: siblingPrice > 0 ? ["wholesale_visible", "wholesale_price"] : ["wholesale_visible"],
          synced_at: new Date().toISOString(),
        });
      } else if (hsnValue) {
        // Reorder path: fill the code if the product has none; a differing
        // existing value is Manage Catalog's to change.
        await admin.from("wholesale_products").update({ hsn: hsnValue }).eq("sku", sku).is("hsn", null);
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
        // Pricing runs on the EX-GST cost (2 Aug) — input credit is claimed.
        { sku, vendor_id: input.vendorId, last_cost: exGstCost(Number(g.unitCost) || 0, { mode: input.gst?.mode ?? null, rate: input.gst?.rate ?? null, inclusive: input.gst?.inclusive ?? null }), last_receipt_date: receiptDate, updated_at: new Date().toISOString() },
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
  return { ok: true, receiptId: receipt.id, receiptNumber, skus: allSkus, designs: Array.from(savedDesigns.values()) };
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

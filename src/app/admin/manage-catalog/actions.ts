"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadProductPhoto } from "@/lib/storage";
import { writeAuditEvent } from "@/lib/audit";
import { applyMovement, canonicalFromMovements, movementsFor } from "@/lib/stock-ledger";

// Fields an admin may edit by hand. Editing one LOCKS it, so the sheet sync
// preserves the manual value until it is unlocked. `image_urls` is locked via
// the photo upload, not this list.
const EDITABLE = ["title", "description", "category", "sub_category", "color", "primary_fabric", "hsn", "location", "wholesale_price", "min_order_qty", "current_qty", "restockable", "restock_days"] as const;
type EditableField = (typeof EDITABLE)[number];

// A number field that doesn't parse is refused, not saved. It used to fall
// back to 0 / null and LOCK — "Rs 1250" or "12,5OO" (letter O on a phone
// keypad) saved ₹0, the counter read "Price not set", and the sheet could no
// longer fix it. Empty still means 0 / null, as before.
const NOT_A_NUMBER = Symbol("not a number");

function coerce(field: EditableField, raw: string): unknown {
  const v = raw.trim();
  if (field === "wholesale_price") { const n = Number(v.replace(/[₹,\s]/g, "")); if (!Number.isFinite(n)) return NOT_A_NUMBER; return n >= 0 ? Math.round(n * 100) / 100 : 0; }
  // Digits only after dropping commas and spaces: stripping every non-digit
  // turned "1O" (letter O) into 1 and "5-6" into 56, saved and locked.
  if (field === "min_order_qty" || field === "restock_days") { if (v === "") return null; const s = v.replace(/[,\s]/g, ""); return /^\d+$/.test(s) ? parseInt(s, 10) : NOT_A_NUMBER; }
  if (field === "current_qty") { if (v === "") return 0; const s = v.replace(/[,\s]/g, ""); return /^-?\d+$/.test(s) ? parseInt(s, 10) : NOT_A_NUMBER; }
  if (field === "restockable") return v === "true" || v.toUpperCase() === "Y" || v.toUpperCase() === "YES";
  return v || null;
}

// Update one or more fields on a product, locking each edited field so the
// next sheet sync won't overwrite it.
export async function updateProductFields(
  sku: string,
  edits: Partial<Record<EditableField, string>>,
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: row } = await admin.from("wholesale_products").select("locked_fields").eq("sku", sku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };

  const patch: Record<string, unknown> = {};
  const locked = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
  for (const [k, raw] of Object.entries(edits)) {
    if (!EDITABLE.includes(k as EditableField)) continue;
    const value = coerce(k as EditableField, raw ?? "");
    if (value === NOT_A_NUMBER) return { ok: false, error: `${k.replace(/_/g, " ")}: '${(raw ?? "").trim()}' is not a number.` };
    patch[k] = value;
    locked.add(k);
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to update." };
  patch.locked_fields = Array.from(locked);

  const { error } = await admin.from("wholesale_products").update(patch).eq("sku", sku);
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `${sku}: ${Object.keys(patch).filter((f) => f !== "locked_fields").join(", ")}` });
  revalidatePath("/admin/manage-catalog");
  revalidatePath("/admin/catalog");
  return { ok: true };
}

// Hand a field back to the sheet (removes it from locked_fields). The next sync
// re-applies the sheet value — except current_qty on a SKU with stock
// movements, which the sync now leaves to the ledger (sheetSyncQty, 4 Oct).
export async function unlockProductField(sku: string, field: string): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: row } = await admin.from("wholesale_products").select("locked_fields").eq("sku", sku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };
  const locked = (Array.isArray(row.locked_fields) ? row.locked_fields : []).filter((f: string) => f !== field);
  const { error } = await admin.from("wholesale_products").update({ locked_fields: locked }).eq("sku", sku);
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `${sku}: unlocked ${field} (sheet controls it again)` });
  revalidatePath("/admin/manage-catalog");
  revalidatePath("/admin/catalog");
  return { ok: true };
}

// Replace a product's photo (locks image_urls so the sync won't re-pull Drive).
export async function uploadProductPhotoAction(sku: string, formData: FormData): Promise<{ ok: boolean; url?: string; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const file = formData.get("image");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No image supplied." };
  if (file.size > 8 * 1024 * 1024) return { ok: false, error: "Image must be under 8 MB." };
  const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!ALLOWED.has(file.type)) return { ok: false, error: "Only JPEG, PNG or WebP images are allowed." };
  const admin = createAdminClient();
  const { data: row } = await admin.from("wholesale_products").select("locked_fields, image_urls").eq("sku", sku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    // Stable key → overwrite one object per SKU (no orphans); cache-bust via the
    // URL query so the CDN still serves the new image.
    const stored = await uploadProductPhoto(sku, bytes, file.type);
    const url = `${stored}?v=${Date.now().toString(36)}`;
    const locked = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
    locked.add("image_urls");
    // Replace the FRONT shot only (slot 0 — the one the modal shows as
    // "Photo"). Writing [url] dated from when a SKU had one image; since the
    // Drive sync copies the whole folder it wiped the back/detail shots, and
    // the lock kept the sync from ever restoring them.
    const rest = Array.isArray(row.image_urls) ? (row.image_urls as string[]).slice(1) : [];
    const { error } = await admin.from("wholesale_products")
      .update({ image_urls: [url, ...rest], images_fetched_at: new Date().toISOString(), locked_fields: Array.from(locked) })
      .eq("sku", sku);
    if (error) return { ok: false, error: error.message };
    await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `${sku}: photo` });
    revalidatePath("/admin/manage-catalog");
    revalidatePath("/admin/catalog");
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Rename a product's SKU. The old SKU is added to sync_ignored_skus so the
// sheet (which still carries it) can't resurrect it as a duplicate.
export async function renameProductSku(oldSku: string, newSkuRaw: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const newSku = newSkuRaw.trim().toUpperCase();
  if (!newSku) return { ok: false, error: "New SKU is required." };
  if (newSku === oldSku.toUpperCase()) return { ok: false, error: "That's the same SKU." };
  if (!/^[A-Z0-9-]+$/.test(newSku)) return { ok: false, error: "SKU may only contain letters, digits and hyphens." };
  const admin = createAdminClient();

  const { data: clash } = await admin.from("wholesale_products").select("sku").eq("sku", newSku).maybeSingle();
  if (clash) return { ok: false, error: `${newSku} already exists.` };

  // Lock the sku field so a sheet row that happens to use newSku can't fight it,
  // and record the old sku on the ignore list.
  const { data: row } = await admin.from("wholesale_products").select("locked_fields, current_qty").eq("sku", oldSku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };
  const locked = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
  locked.add("sku");

  const { error } = await admin.from("wholesale_products").update({ sku: newSku, locked_fields: Array.from(locked) }).eq("sku", oldSku);
  if (error) return { ok: false, error: error.message };
  await admin.from("sync_ignored_skus").upsert({ sku: oldSku.toUpperCase(), reason: `renamed to ${newSku}` });

  // Only the catalog row changes its key above. Nothing cascades: the stock
  // ledger and product_vendor_info are keyed by plain-text sku, so without
  // these two carries the next sale on the new SKU computed stock from that
  // one movement (5 pieces → -1) and the tag lost its vendor code and sheet
  // MRP (the old SKU's sheet row is ignored from here on).
  //
  // Stock carries as ONE correction on the new SKU, not by re-keying the old
  // movements: those rows reference the orders, bills and receipts that still
  // name the old SKU, and reversals/restocks match them on (sku, ref_id). The
  // target is the carried balance, not an increment, so renaming back to a
  // SKU that still has its own ledger lands on the right count too. A
  // correction (not setStock) so a negative balance stays honest.
  //
  // A product with no ledger rows at all (a sheet row that has never moved
  // since 0026 seeded the ledger) has only its cached count, so that is what
  // carries — the same opening balance 0026 gave every product. Carrying the
  // ledger's 0 there would leave the next sale to reset it to one delta.
  //
  // The carry IS the new SKU's opening balance, so applyMovement must not seed
  // one of its own on top (openingBalance: false): the renamed row still
  // shows the old count, and seeding it would count the stock twice. For the
  // same reason a new SKU with no ledger gets its carry written even when it
  // is 0 — left empty, its first movement would seed whatever the screen
  // showed, not the ledger's figure this rename went by.
  const problems: string[] = [];
  const oldMoves = await movementsFor(oldSku);
  const shown = Math.trunc(Number(row.current_qty) || 0);
  const carried = oldMoves.length > 0 ? canonicalFromMovements(oldMoves) : shown;
  const newMoves = await movementsFor(newSku);
  const current = canonicalFromMovements(newMoves);
  if (carried !== current || (newMoves.length === 0 && shown !== carried)) {
    const mv = await applyMovement({
      sku: newSku, delta: carried - current, reason: "correction", refType: "rename",
      note: `Carried over from rename of ${oldSku.toUpperCase()}`, createdBy: staff.email,
      openingBalance: false,
    });
    if (!mv.ok) problems.push(`stock did NOT carry over (${mv.error ?? "movement failed"}) — set ${carried} pc in Stock take`);
  }
  // Vendor / retail row: copied, never overwriting a row the new SKU already
  // has (the sheet's own, or this product's from before an earlier rename).
  let vendorCopied = false;
  const { data: vendor, error: vendorReadErr } = await admin.from("product_vendor_info").select("*").eq("sku", oldSku.toUpperCase()).maybeSingle();
  if (vendorReadErr) problems.push(`vendor info could not be read (${vendorReadErr.message})`);
  else if (vendor) {
    const { error: vendorErr } = await admin.from("product_vendor_info").upsert({ ...vendor, sku: newSku }, { onConflict: "sku", ignoreDuplicates: true });
    if (vendorErr) problems.push(`vendor info did NOT copy (${vendorErr.message})`);
    else vendorCopied = true;
  }

  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    // The screen's count goes in too when it differed from the ledger, so the
    // jump to the ledger's figure can be traced later.
    notes: `rename ${oldSku} → ${newSku} · ledger ${carried} pc${oldMoves.length === 0 ? " (no ledger yet, carried the shown count)" : shown !== carried ? ` (screen showed ${shown} pc)` : ""}${vendorCopied ? " · vendor info copied" : ""}${problems.length ? ` · ${problems.join("; ")}` : ""}`,
  });
  revalidatePath("/admin/manage-catalog");
  // A half-carry must be reported or nobody would know the ledger is short.
  // ok:true + warning, not ok:false: the rename itself DID happen, and the
  // modal is unmounted by the revalidation, so the caller shows this as an
  // alert.
  if (problems.length) return { ok: true, warning: `Renamed to ${newSku}, but ${problems.join("; ")}.` };
  return { ok: true };
}

// Show/hide a product in the BUYER catalog.
//
// This writes buyer_visible, not wholesale_visible (0062). The button has
// always said "Hide from catalog", and the catalog it means is the one buyers
// log in to see — wholesale_visible is the sheet/ops flag that keeps a garment
// billable at the counter, and pulling something from the storefront must not
// take it out of the booth's scanner. No lock is needed either: the sheet sync
// never names buyer_visible, so there is nothing to protect it from.
export async function setProductVisibility(sku: string, visible: boolean): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: row } = await admin.from("wholesale_products").select("sku").eq("sku", sku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };
  const { error } = await admin.from("wholesale_products").update({ buyer_visible: visible }).eq("sku", sku);
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `${sku}: ${visible ? "shown to buyers" : "hidden from buyers"}` });
  revalidatePath("/admin/manage-catalog");
  revalidatePath("/admin/catalog");
  return { ok: true };
}

// Sellable at the counter — the OTHER half of the flag that 0062 split.
//
// Moving the catalog toggle onto buyer_visible left wholesale_visible with no
// control anywhere in the app, and it is the flag every billing screen reads.
// That matters on real rows: 14 SKUs sit at false today, one of them
// (DD-LEH-FLR-084-L-BRN) on two live orders it can no longer be re-added to.
// The sheet can set it, but only by someone editing a spreadsheet column that
// is read as a negative — so the capability belongs here too.
//
// It locks, unlike its buyer twin: the sheet sync hardcodes this column true
// for every row it carries, so an app decision to hold one back survives the
// next cron only if it is locked.
export async function setProductSellable(sku: string, sellable: boolean): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: row } = await admin.from("wholesale_products").select("locked_fields").eq("sku", sku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };
  const locked = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
  locked.add("wholesale_visible");
  const { error } = await admin
    .from("wholesale_products")
    .update({ wholesale_visible: sellable, locked_fields: Array.from(locked) })
    .eq("sku", sku);
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `${sku}: ${sellable ? "sellable at the counter" : "withdrawn from billing"}` });
  revalidatePath("/admin/manage-catalog");
  return { ok: true };
}

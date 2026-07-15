"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadProductPhoto } from "@/lib/storage";
import { writeAuditEvent } from "@/lib/audit";

// Fields an admin may edit by hand. Editing one LOCKS it, so the sheet sync
// preserves the manual value until it is unlocked. `image_urls` is locked via
// the photo upload, not this list.
const EDITABLE = ["title", "description", "category", "sub_category", "color", "primary_fabric", "wholesale_price", "min_order_qty", "current_qty", "restockable", "restock_days"] as const;
type EditableField = (typeof EDITABLE)[number];

function coerce(field: EditableField, raw: string): unknown {
  const v = raw.trim();
  if (field === "wholesale_price") { const n = Number(v.replace(/[₹,\s]/g, "")); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; }
  if (field === "min_order_qty" || field === "restock_days") { if (v === "") return null; const n = parseInt(v.replace(/[^\d]/g, ""), 10); return Number.isFinite(n) ? n : null; }
  if (field === "current_qty") { const n = parseInt(v.replace(/[^\d-]/g, ""), 10); return Number.isFinite(n) ? n : 0; }
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
    patch[k] = coerce(k as EditableField, raw ?? "");
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
// re-applies the sheet value.
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
  const { data: row } = await admin.from("wholesale_products").select("locked_fields").eq("sku", sku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    // Stable key → overwrite one object per SKU (no orphans); cache-bust via the
    // URL query so the CDN still serves the new image.
    const stored = await uploadProductPhoto(sku, bytes, file.type);
    const url = `${stored}?v=${Date.now().toString(36)}`;
    const locked = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
    locked.add("image_urls");
    const { error } = await admin.from("wholesale_products")
      .update({ image_urls: [url], images_fetched_at: new Date().toISOString(), locked_fields: Array.from(locked) })
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
export async function renameProductSku(oldSku: string, newSkuRaw: string): Promise<{ ok: boolean; error?: string }> {
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
  const { data: row } = await admin.from("wholesale_products").select("locked_fields").eq("sku", oldSku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };
  const locked = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
  locked.add("sku");

  const { error } = await admin.from("wholesale_products").update({ sku: newSku, locked_fields: Array.from(locked) }).eq("sku", oldSku);
  if (error) return { ok: false, error: error.message };
  await admin.from("sync_ignored_skus").upsert({ sku: oldSku.toUpperCase(), reason: `renamed to ${newSku}` });
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `rename ${oldSku} → ${newSku}` });
  revalidatePath("/admin/manage-catalog");
  return { ok: true };
}

// Show/hide a product (locks wholesale_visible).
export async function setProductVisibility(sku: string, visible: boolean): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: row } = await admin.from("wholesale_products").select("locked_fields").eq("sku", sku).maybeSingle();
  if (!row) return { ok: false, error: "Product not found." };
  const locked = new Set<string>(Array.isArray(row.locked_fields) ? row.locked_fields : []);
  locked.add("wholesale_visible");
  const { error } = await admin.from("wholesale_products").update({ wholesale_visible: visible, locked_fields: Array.from(locked) }).eq("sku", sku);
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `${sku}: ${visible ? "shown" : "hidden"}` });
  revalidatePath("/admin/manage-catalog");
  revalidatePath("/admin/catalog");
  return { ok: true };
}

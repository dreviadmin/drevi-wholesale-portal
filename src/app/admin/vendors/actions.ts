"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import type { AuditEventType } from "@/lib/types";
import { storeAuxPhoto } from "@/lib/design-image-store";

export interface VendorForm {
  name: string;
  phone?: string; whatsapp?: string; city?: string; address?: string; gstin?: string; notes?: string;
  contactName?: string; email?: string;
}

function clean(form: VendorForm) {
  return {
    name: form.name.trim(),
    phone: form.phone?.trim() || null,
    whatsapp: form.whatsapp?.trim() || null,
    city: form.city?.trim() || null,
    address: form.address?.trim() || null,
    gstin: form.gstin?.trim() || null,
    notes: form.notes?.trim() || "",
    contact_name: form.contactName?.trim() || null,
    email: form.email?.trim() || null,
  };
}

export async function createVendor(form: VendorForm): Promise<{ ok: boolean; id?: string; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const v = clean(form);
  if (!v.name) return { ok: false, error: "Vendor name is required." };
  const admin = createAdminClient();
  const { data, error } = await admin.from("vendors").insert(v).select("id").single();
  if (error) {
    return { ok: false, error: error.code === "23505" ? `A vendor named "${v.name}" already exists.` : error.message };
  }
  await writeAuditEvent({ eventType: "vendor_created" as AuditEventType, staffUserId: staff.id, notes: v.name });
  revalidatePath("/admin/vendors");
  return { ok: true, id: data.id };
}

export async function updateVendor(id: string, form: VendorForm & { active?: boolean }): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const v = clean(form);
  if (!v.name) return { ok: false, error: "Vendor name is required." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("vendors")
    .update({ ...v, ...(form.active != null ? { active: form.active } : {}), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    return { ok: false, error: error.code === "23505" ? `A vendor named "${v.name}" already exists.` : error.message };
  }
  await writeAuditEvent({ eventType: "vendor_updated" as AuditEventType, staffUserId: staff.id, notes: v.name });
  revalidatePath("/admin/vendors");
  revalidatePath(`/admin/vendors/${id}`);
  return { ok: true };
}

// Inline quick-add from the receipt form: name + phone only.
export async function quickAddVendor(name: string, phone?: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  return createVendor({ name, phone });
}

/**
 * UX sprint — attach the business card or the contact person's photo.
 * Stored in the private vendor-photos bucket, served via /api/drive-photo.
 */
export async function uploadVendorPhoto(
  vendorId: string,
  kind: "card" | "person",
  formData: FormData,
): Promise<{ ok: boolean; error?: string; ref?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No photo" };
  if (file.size > 8 * 1024 * 1024) return { ok: false, error: "Photo too large (8 MB max)" };

  const admin = createAdminClient();
  const { data: vendor } = await admin.from("vendors").select("id, name").eq("id", vendorId).maybeSingle();
  if (!vendor) return { ok: false, error: "Vendor not found" };

  const ext = (file.type || "").includes("png") ? "png" : "jpg";
  let ref;
  try {
    ref = await storeAuxPhoto({
      bucket: "vendor-photos",
      path: `${vendorId}/${kind}-${Date.now()}.${ext}`,
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "image/jpeg",
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Upload failed" };
  }
  const column = kind === "card" ? "card_image_ref" : "person_image_ref";
  const { error } = await admin.from("vendors").update({ [column]: ref, updated_at: new Date().toISOString() }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "vendor_updated" as AuditEventType, staffUserId: staff.id, notes: `${kind} photo on ${vendor.name}` });
  revalidatePath("/admin/vendors");
  revalidatePath(`/admin/vendors/${vendorId}`);
  return { ok: true, ref };
}

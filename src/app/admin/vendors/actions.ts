"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import type { AuditEventType } from "@/lib/types";

export interface VendorForm {
  name: string;
  phone?: string; whatsapp?: string; city?: string; address?: string; gstin?: string; notes?: string;
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

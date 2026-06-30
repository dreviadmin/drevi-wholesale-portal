"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/staff";
import { writeAuditEvent } from "@/lib/audit";
import { encryptPassword, decryptPassword } from "@/lib/crypto";
import { generateMemorablePassword } from "@/lib/password";
import type { BuyerStatus } from "@/lib/types";

function reqMeta() {
  const h = headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim() || null;
  return { ip, userAgent: h.get("user-agent") };
}

async function findAuthUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const f = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (f) return f.id;
    if (data.users.length < 200) break;
  }
  return null;
}

// Set the password in Supabase Auth (bcrypt) for `email`, creating the auth user
// if needed. Returns the auth user id.
async function setAuthPassword(admin: SupabaseClient, email: string, password: string): Promise<string> {
  const existing = await findAuthUserId(admin, email);
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing, { password, email_confirm: true });
    if (error) throw error;
    return existing;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

function revalidate(buyerId: string) {
  revalidatePath("/admin/buyers");
  revalidatePath(`/admin/buyers/${buyerId}`);
}

export interface CredResult {
  ok: boolean;
  password?: string;
  error?: string;
}

/**
 * Save & Activate (credential modal). Sets the buyer's password in Supabase
 * Auth AND the AES ciphertext in encrypted_password, activates the buyer, and
 * logs credential_created. Returns the plaintext so the UI can share it.
 */
export async function setCredentials(
  buyerId: string,
  emailInput: string,
  password: string,
): Promise<CredResult> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  if (!password || password.length < 6) return { ok: false, error: "Password must be at least 6 characters." };

  const admin = createAdminClient();
  const { data: buyer } = await admin.from("buyers").select("id, email").eq("id", buyerId).maybeSingle();
  if (!buyer) return { ok: false, error: "Buyer not found." };

  const email = (emailInput || buyer.email || "").trim().toLowerCase();
  if (!email) return { ok: false, error: "An email is required to activate the login." };
  try {
    await setAuthPassword(admin, email, password);
  } catch (e) {
    return { ok: false, error: `Could not set login: ${(e as Error).message}` };
  }

  const { error } = await admin
    .from("buyers")
    .update({
      email,
      encrypted_password: encryptPassword(password),
      status: "active",
      approved_by: staff.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", buyerId);
  if (error) return { ok: false, error: error.message };

  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({ eventType: "credential_created", buyerId, staffUserId: staff.id, ipAddress: ip, userAgent });
  revalidate(buyerId);
  return { ok: true, password };
}

export async function revealPassword(buyerId: string): Promise<CredResult> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const admin = createAdminClient();
  const { data: buyer } = await admin.from("buyers").select("encrypted_password").eq("id", buyerId).maybeSingle();
  if (!buyer?.encrypted_password) return { ok: false, error: "No password on file." };
  let plain: string;
  try {
    plain = decryptPassword(buyer.encrypted_password);
  } catch {
    return { ok: false, error: "Could not decrypt." };
  }
  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({ eventType: "credential_viewed", buyerId, staffUserId: staff.id, ipAddress: ip, userAgent });
  revalidate(buyerId);
  return { ok: true, password: plain };
}

export async function regeneratePassword(buyerId: string): Promise<CredResult> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const admin = createAdminClient();
  const { data: buyer } = await admin.from("buyers").select("email").eq("id", buyerId).maybeSingle();
  if (!buyer) return { ok: false, error: "Buyer not found." };
  const password = generateMemorablePassword();
  try {
    await setAuthPassword(admin, buyer.email, password);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  await admin.from("buyers").update({ encrypted_password: encryptPassword(password) }).eq("id", buyerId);
  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({ eventType: "credential_regenerated", buyerId, staffUserId: staff.id, ipAddress: ip, userAgent });
  revalidate(buyerId);
  return { ok: true, password };
}

export async function changePassword(buyerId: string, newPassword: string): Promise<CredResult> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  if (!newPassword || newPassword.length < 6) return { ok: false, error: "Password must be at least 6 characters." };
  const admin = createAdminClient();
  const { data: buyer } = await admin.from("buyers").select("email").eq("id", buyerId).maybeSingle();
  if (!buyer) return { ok: false, error: "Buyer not found." };
  try {
    await setAuthPassword(admin, buyer.email, newPassword);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  await admin.from("buyers").update({ encrypted_password: encryptPassword(newPassword) }).eq("id", buyerId);
  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({ eventType: "credential_changed", buyerId, staffUserId: staff.id, ipAddress: ip, userAgent });
  revalidate(buyerId);
  return { ok: true, password: newPassword };
}

// Decrypt the password for sharing (Copy / WhatsApp) and log credential_shared
// with the channel. Distinct from revealPassword (which logs credential_viewed).
export async function shareCredentials(buyerId: string, channel: string): Promise<CredResult> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const admin = createAdminClient();
  const { data: buyer } = await admin.from("buyers").select("encrypted_password").eq("id", buyerId).maybeSingle();
  if (!buyer?.encrypted_password) return { ok: false, error: "No password on file." };
  let plain: string;
  try {
    plain = decryptPassword(buyer.encrypted_password);
  } catch {
    return { ok: false, error: "Could not decrypt." };
  }
  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({ eventType: "credential_shared", buyerId, staffUserId: staff.id, ipAddress: ip, userAgent, notes: channel });
  return { ok: true, password: plain };
}

export async function setBuyerStatus(buyerId: string, status: BuyerStatus, reason?: string): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const admin = createAdminClient();
  const patch: Record<string, unknown> = { status };
  let event: "account_suspended" | "account_reactivated" | "account_rejected" | null = null;
  if (status === "suspended") event = "account_suspended";
  else if (status === "active") event = "account_reactivated";
  else if (status === "rejected") {
    event = "account_rejected";
    patch.rejected_by = staff.id;
    patch.rejected_at = new Date().toISOString();
    patch.rejection_reason = reason ?? null;
  }
  const { error } = await admin.from("buyers").update(patch).eq("id", buyerId);
  if (error) return { ok: false, error: error.message };
  if (event) {
    const { ip, userAgent } = reqMeta();
    await writeAuditEvent({ eventType: event, buyerId, staffUserId: staff.id, ipAddress: ip, userAgent, notes: reason ?? null });
  }
  revalidate(buyerId);
  return { ok: true };
}

// Case B — create a buyer manually (pending/manual_admin). business/email/city
// are optional (a captured buyer may not have all of them yet); email becomes
// required at credential activation. Returns the new id so the UI can open the
// credential modal immediately.
export async function addBuyer(form: {
  business_name?: string;
  owner_name?: string;
  email?: string;
  phone?: string;
  city?: string;
  gstin?: string;
  address?: string;
  transport_details?: string;
  broker_details?: string;
  other_details?: string;
  notes?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const email = form.email?.trim().toLowerCase() || null;
  // Require at least one identifier so the buyer is recognisable.
  if (!form.owner_name?.trim() && !form.business_name?.trim() && !form.phone?.trim()) {
    return { ok: false, error: "Add at least one of owner name, business name, or phone." };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("buyers")
    .insert({
      email,
      business_name: form.business_name?.trim() || null,
      owner_name: form.owner_name?.trim() || null,
      phone: form.phone?.trim() || null,
      city: form.city?.trim() || null,
      gstin: form.gstin?.trim() || null,
      address: form.address?.trim() || null,
      transport_details: form.transport_details?.trim() || null,
      broker_details: form.broker_details?.trim() || null,
      other_details: form.other_details?.trim() || null,
      notes: form.notes?.trim() || null,
      status: "pending",
      source: "manual_admin",
      captured_by: staff.id,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, error: "A buyer with that email already exists." };
    return { ok: false, error: error.message };
  }
  revalidatePath("/admin/buyers");
  return { ok: true, id: data.id };
}

export async function addNote(buyerId: string, note: string): Promise<void> {
  try {
    await requireAdmin();
  } catch {
    return;
  }
  const admin = createAdminClient();
  await admin.from("buyers").update({ notes: note }).eq("id", buyerId);
  revalidate(buyerId);
}

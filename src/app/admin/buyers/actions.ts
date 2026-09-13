"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireStaff } from "@/lib/staff";
import { writeAuditEvent } from "@/lib/audit";
import { encryptPassword, decryptPassword } from "@/lib/crypto";
import { generateMemorablePassword } from "@/lib/password";
import { uploadBuyerCardImage } from "@/lib/storage";
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

  // Duplicate emails are allowed on buyer ROWS, but a login identity must be
  // unique — refuse activation if another credentialed buyer already uses it.
  const { data: clash } = await admin
    .from("buyers")
    .select("id, business_name")
    .eq("email", email)
    .neq("id", buyerId)
    .not("encrypted_password", "is", null)
    .limit(1);
  if (clash && clash.length > 0) {
    return { ok: false, error: `${email} already logs in for ${clash[0].business_name ?? "another buyer"} — use a different email.` };
  }

  // Staff and buyers share one Supabase Auth pool. Activating a buyer with a
  // staff member's email would reset that staff login's password — refuse.
  const { data: staffClash } = await admin.from("staff_users").select("id").eq("email", email).limit(1);
  if (staffClash && staffClash.length > 0) {
    return { ok: false, error: `${email} is a staff login — use a different email for this buyer.` };
  }

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
  // Idempotency: flaky-wifi retries of the same Add Buyer resolve to one row
  // (same pattern as the exhibition capture — audit fix).
  clientRef?: string;
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
  const clientRef = form.clientRef?.trim() || null;
  if (clientRef) {
    const { data: existing } = await admin.from("buyers").select("id").eq("client_ref", clientRef).maybeSingle();
    if (existing) return { ok: true, id: existing.id };
  }
  const { data, error } = await admin
    .from("buyers")
    .insert({
      email,
      client_ref: clientRef,
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
    // Lost the check-then-insert race — another retry won; return that row.
    if (error.code === "23505" && clientRef) {
      const { data: won } = await admin.from("buyers").select("id").eq("client_ref", clientRef).maybeSingle();
      if (won) return { ok: true, id: won.id };
    }
    return { ok: false, error: error.message };
  }
  await writeAuditEvent({
    eventType: "buyer_created",
    staffUserId: staff.id,
    buyerId: data.id,
    notes: form.business_name?.trim() || form.owner_name?.trim() || email || "buyer",
  });
  revalidatePath("/admin/buyers");
  return { ok: true, id: data.id };
}

// Full buyer profile edit from the admin buyer page. Email is deliberately
// excluded — it's the login username and belongs to the credential flow.
const PROFILE_FIELDS = [
  "business_name", "owner_name", "phone", "city",
  "gstin", "address", "transport_details", "broker_details", "other_details",
] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

export async function updateBuyerProfile(
  buyerId: string,
  form: Partial<Record<ProfileField, string>>,
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  if (!buyerId) return { ok: false, error: "No buyer to update." };

  const admin = createAdminClient();
  const { data: current } = await admin
    .from("buyers")
    .select(PROFILE_FIELDS.join(", "))
    .eq("id", buyerId)
    .maybeSingle();
  if (!current) return { ok: false, error: "Buyer not found." };
  const row = current as unknown as Record<ProfileField, string | null>;

  // PATCH, not overwrite. Callers send only the fields their form owns — the
  // order-page editor has no other_details, and BuyerDetail sends just the
  // fields the admin actually edited — so writing the whole column set would
  // NULL everything the caller left out. A staff member fixing a typo in the
  // city would have wiped the buyer's GSTIN, address and phone, which now also
  // means wiping what a buyer set for themselves at /account/details.
  //
  // Only genuinely-changed fields are written, so a save that touches nothing
  // neither writes nor audits.
  const next: Record<string, string | null> = {};
  for (const k of PROFILE_FIELDS) {
    if (!(k in form)) continue;
    const value = form[k]?.trim() || null;
    if (value !== (row[k] ?? null)) next[k] = value;
  }

  // The invariant holds over the RESULTING row, not over the patch: a patch of
  // { city } says nothing about whether the buyer still has a name.
  const merged = { ...row, ...next };
  if (!merged.business_name?.trim() && !merged.owner_name?.trim() && !merged.phone?.trim()) {
    return { ok: false, error: "Keep at least one of business name, owner name, or phone." };
  }

  const changed = Object.keys(next);
  if (changed.length === 0) return { ok: true };

  const { error } = await admin.from("buyers").update(next).eq("id", buyerId);
  if (error) return { ok: false, error: error.message };

  // Which fields moved, never their values — this log is read through a shared
  // 300-row window and buyer identity is not the place for it.
  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({
    eventType: "buyer_profile_updated",
    buyerId,
    staffUserId: staff.id,
    ipAddress: ip,
    userAgent,
    notes: `staff edit: ${changed.join(", ")}`,
  });

  revalidate(buyerId);
  return { ok: true };
}

// Visiting card / photo upload. Staff-level (exhibition capture uses it too).
export async function uploadBuyerCard(buyerId: string, formData: FormData): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireStaff();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const file = formData.get("card");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No image supplied." };
  if (file.size > 5 * 1024 * 1024) return { ok: false, error: "Image must be under 5 MB." };
  try {
    const path = await uploadBuyerCardImage(buyerId, file);
    const admin = createAdminClient();
    await admin.from("buyers").update({ card_image_path: path }).eq("id", buyerId);
    revalidate(buyerId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
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

// ── Buyer-requested identity changes (13 Sep) ───────────────────────────────
// business_name and gstin print on every GST tax invoice, so a buyer may ask
// for them but not set them (migration 0048). The decision is one RPC because
// two writes must land together — flip the request, write the buyers column —
// and PostgREST offers no transaction across two calls. Every guard lives in
// decide_buyer_change: already-decided, buyer-not-active, and before_value
// drift all raise there, under a row lock. Its message is written for a human,
// so it is surfaced verbatim rather than translated.

export interface ChangeRequestRow {
  id: string;
  buyer_id: string;
  field: "business_name" | "gstin";
  before_value: string | null;
  requested_value: string;
  buyer_note: string | null;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

/** Every request for one buyer, newest first — pending ones are actionable. */
export async function loadChangeRequests(buyerId: string): Promise<ChangeRequestRow[]> {
  try {
    await requireStaff();
  } catch {
    return [];
  }
  const { data } = await createAdminClient()
    .from("buyer_change_requests")
    .select("id, buyer_id, field, before_value, requested_value, buyer_note, status, requested_at, decided_at, decision_note")
    .eq("buyer_id", buyerId)
    .order("requested_at", { ascending: false })
    .limit(20);
  return (data ?? []) as ChangeRequestRow[];
}

/** How many are waiting across all buyers — for the admin cockpit count. */
export async function countPendingChangeRequests(): Promise<number> {
  try {
    await requireStaff();
  } catch {
    return 0;
  }
  const { count } = await createAdminClient()
    .from("buyer_change_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  return count ?? 0;
}

export async function decideChangeRequest(
  requestId: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }

  const trimmed = (note ?? "").trim();
  // Enforced by bcr_reject_has_reason too, but failing here gives the person a
  // sentence instead of a constraint name.
  if (decision === "rejected" && !trimmed) {
    return { ok: false, error: "Give a reason — the buyer sees it." };
  }

  const admin = createAdminClient();
  const { data: req } = await admin
    .from("buyer_change_requests")
    .select("buyer_id, field, before_value, requested_value")
    .eq("id", requestId)
    .maybeSingle();
  if (!req) return { ok: false, error: "That request no longer exists." };

  const { data: replaced, error } = await admin.rpc("decide_buyer_change", {
    p_request: requestId,
    p_decision: decision,
    p_staff: staff.id,
    p_note: trimmed || null,
  });
  if (error) return { ok: false, error: error.message };

  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({
    eventType: decision === "approved" ? "buyer_change_approved" : "buyer_change_rejected",
    buyerId: req.buyer_id as string,
    staffUserId: staff.id,
    ipAddress: ip,
    userAgent,
    notes:
      decision === "approved"
        ? `${req.field}: ${replaced ?? "(empty)"} -> ${req.requested_value}`
        : `${req.field}: refused (${trimmed})`,
  });

  revalidate(req.buyer_id as string);
  revalidatePath("/admin/home");
  return { ok: true };
}

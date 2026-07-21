"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { requireAdmin, type StaffCtx } from "@/lib/staff";
import { generateMemorablePassword } from "@/lib/password";
import type { AuditEventType, StaffRole } from "@/lib/types";

// Hierarchy (spec + Ansh 2026-05-29): super_admin manages admins + staff;
// admin manages staff only; nobody manages super_admin accounts from the UI.
function canManage(actor: StaffCtx, targetRole: StaffRole): boolean {
  if (targetRole === "super_admin") return false;
  if (actor.role === "super_admin") return true;
  return actor.role === "admin" && targetRole === "staff";
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

// Creates the staff_users row + a Supabase Auth login with a generated
// password (returned once for sharing; staff passwords are hashed-only).
export async function addStaffUser(form: {
  name: string;
  email: string;
  role: StaffRole;
}): Promise<{ ok: boolean; password?: string; error?: string }> {
  let actor: StaffCtx;
  try {
    actor = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const email = form.email.trim().toLowerCase();
  const name = form.name.trim();
  if (!email || !name) return { ok: false, error: "Name and email are required." };
  if (!canManage(actor, form.role)) return { ok: false, error: "Your role can't create that account type." };

  const admin = createAdminClient();

  // An email that already belongs to a staff account must NEVER be re-added:
  // the old flow silently reset that person's password and overwrote their
  // role via upsert — an admin could lock out the super-admin by "re-adding"
  // them. Deactivate/reactivate or a dedicated reset flow are the safe paths.
  const { data: staffClash } = await admin.from("staff_users").select("id, name, role, active").eq("email", email).maybeSingle();
  if (staffClash) {
    return {
      ok: false,
      error: `${email} already belongs to ${staffClash.name ?? "a staff member"} (${staffClash.role}${staffClash.active ? "" : ", inactive"}). Use Reactivate on the list instead of re-adding — re-adding would reset their password.`,
    };
  }

  // Staff and buyers share one Supabase Auth pool. Creating a staff account with
  // an email a buyer already logs in with would reset the buyer's password —
  // refuse (mirror of the guard in setCredentials).
  const { data: buyerClash } = await admin.from("buyers").select("id").eq("email", email).not("encrypted_password", "is", null).limit(1);
  if (buyerClash && buyerClash.length > 0) {
    return { ok: false, error: `${email} is already a buyer login — use a different email for staff.` };
  }

  const password = generateMemorablePassword();

  const existing = await findAuthUserId(admin, email);
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing, { password, email_confirm: true });
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return { ok: false, error: error.message };
  }

  const { error } = await admin
    .from("staff_users")
    .insert({ email, name, role: form.role, active: true });
  if (error) {
    return { ok: false, error: error.code === "23505" ? `${email} already has a staff account.` : error.message };
  }

  await writeAuditEvent({ eventType: "staff_created" as AuditEventType, staffUserId: actor.id, notes: `${email} (${form.role})` });
  revalidatePath("/admin/staff");
  return { ok: true, password };
}

export async function setStaffActive(staffId: string, active: boolean): Promise<{ ok: boolean; error?: string }> {
  let actor: StaffCtx;
  try {
    actor = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  if (staffId === actor.id) return { ok: false, error: "You can't deactivate your own account." };

  const admin = createAdminClient();
  const { data: target } = await admin.from("staff_users").select("role").eq("id", staffId).maybeSingle();
  if (!target) return { ok: false, error: "Not found." };
  if (!canManage(actor, target.role as StaffRole)) return { ok: false, error: "Your role can't modify that account." };

  const { error } = await admin.from("staff_users").update({ active }).eq("id", staffId);
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({
    eventType: (active ? "staff_reactivated" : "staff_deactivated") as AuditEventType,
    staffUserId: actor.id,
    notes: staffId,
  });
  revalidatePath("/admin/staff");
  return { ok: true };
}

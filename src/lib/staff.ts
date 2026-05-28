import "server-only";

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StaffRole } from "@/lib/types";

export interface StaffCtx {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
}

// The currently authenticated active staff user, or null. Looked up by email
// (the link between auth.users and staff_users).
export async function getStaff(): Promise<StaffCtx | null> {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("staff_users")
    .select("id, email, name, role, active")
    .eq("email", user.email)
    .maybeSingle();
  if (!data || !data.active) return null;
  return { id: data.id, email: data.email, name: data.name, role: data.role as StaffRole };
}

export async function requireStaff(): Promise<StaffCtx> {
  const staff = await getStaff();
  if (!staff) throw new Error("Not authorized");
  return staff;
}

// Credential routes additionally require admin / super_admin (spec §5).
export async function requireAdmin(): Promise<StaffCtx> {
  const staff = await requireStaff();
  if (staff.role !== "admin" && staff.role !== "super_admin") {
    throw new Error("Not authorized — admin role required");
  }
  return staff;
}

export function isAdminRole(role: StaffRole): boolean {
  return role === "admin" || role === "super_admin";
}

// Page-level gate: admin/super_admin only (spec §5 — Buyers/Orders/Audit tabs).
// Non-admin staff are sent to their only admin-area surface (Exhibitions).
export async function requireAdminOrRedirect(): Promise<StaffCtx> {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  if (!isAdminRole(staff.role)) redirect("/admin/exhibition");
  return staff;
}

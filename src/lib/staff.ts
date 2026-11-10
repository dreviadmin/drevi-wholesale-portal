import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StaffRole } from "@/lib/types";
import { classifyStaffLookup } from "@/lib/staff-core";

export interface StaffCtx {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
}

export type StaffLookup = { kind: "staff"; staff: StaffCtx } | { kind: "none" } | { kind: "error" };

// Who is signed in, keeping "not staff" apart from "could not find out": a
// failed staff_users read used to look like no row, and the admin layout sent
// a signed-in person to /login on a database blip (staff-core.ts). Looked up
// by email (the link between auth.users and staff_users).
//
// Wrapped in React cache(): the admin layout and the page's own gate both ask
// within one render, and each ask used to cost an auth getUser call plus a
// staff_users read. Inside a render the answer is shared for that request
// only; outside one (route handlers, server actions) cache() calls straight
// through, so those still check every time.
export const lookupStaff = cache(async (): Promise<StaffLookup> => {
  const supabase = createServerSupabase();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  let row: { id: string; email: string; name: string | null; role: string; active: boolean | null } | null = null;
  let rowError: unknown = null;
  if (user?.email) {
    const admin = createAdminClient();
    const res = await admin
      .from("staff_users")
      .select("id, email, name, role, active")
      .eq("email", user.email)
      .maybeSingle();
    row = res.data;
    rowError = res.error;
  }

  const kind = classifyStaffLookup({ hasUser: !!user?.email, authError, rowError, row });
  if (kind !== "staff" || !row) return { kind: kind === "error" ? "error" : "none" };
  return { kind: "staff", staff: { id: row.id, email: row.email, name: row.name, role: row.role as StaffRole } };
});

// The currently authenticated active staff user, or null (including when the
// lookup failed). API routes and server actions use this.
export async function getStaff(): Promise<StaffCtx | null> {
  const res = await lookupStaff();
  return res.kind === "staff" ? res.staff : null;
}

// Thrown by the page gates when the lookup failed: admin/error.tsx shows a
// retry card instead of the gate redirecting a signed-in person to /login.
function lookupFailed(): never {
  throw new Error("Could not check your sign-in. You are still signed in.");
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

// Page-level gate: any active staff (retail billing, price checks).
export async function requireStaffOrRedirect(): Promise<StaffCtx> {
  const res = await lookupStaff();
  if (res.kind === "error") lookupFailed();
  if (res.kind === "none") redirect("/login");
  return res.staff;
}

// Page-level gate: admin/super_admin only (spec §5 — Buyers/Orders/Audit tabs).
// Non-admin staff are sent to the staff home (Home, where everyone lands).
export async function requireAdminOrRedirect(): Promise<StaffCtx> {
  const res = await lookupStaff();
  if (res.kind === "error") lookupFailed();
  if (res.kind === "none") redirect("/login");
  if (!isAdminRole(res.staff.role)) redirect("/admin/home");
  return res.staff;
}

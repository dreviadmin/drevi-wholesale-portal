import { redirect } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { AutoRefresh } from "@/components/AutoRefresh";
import { createAdminClient } from "@/lib/supabase/admin";
import { StaffManager } from "./StaffManager";
import type { StaffUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Staff management. Ansh (4 Aug): user management is super_admin-only now —
// every other role gets the full portal EXCEPT this page. super_admin rows
// stay immutable from the UI.
export default async function StaffPage() {
  const actor = await requireAdminOrRedirect();
  if (actor.role !== "super_admin") redirect("/admin/home");
  const admin = createAdminClient();
  const { data } = await admin.from("staff_users").select("*").order("created_at");

  return (
    <><AutoRefresh />
    <StaffManager
      actor={{ id: actor.id, role: actor.role }}
      rows={((data ?? []) as StaffUser[]).map((s) => ({
        id: s.id,
        email: s.email,
        name: s.name,
        role: s.role,
        active: s.active,
      }))}
    />
    </>
  );
}

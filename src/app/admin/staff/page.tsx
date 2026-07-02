import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { StaffManager } from "./StaffManager";
import type { StaffUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Staff management. super_admin manages admins + staff; admin manages staff
// only. super_admin rows are shown but immutable from the UI.
export default async function StaffPage() {
  const actor = await requireAdminOrRedirect();
  const admin = createAdminClient();
  const { data } = await admin.from("staff_users").select("*").order("created_at");

  return (
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
  );
}

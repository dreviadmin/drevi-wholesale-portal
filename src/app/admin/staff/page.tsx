import { redirect } from "next/navigation";
import { getStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { palette } from "@/lib/palette";
import type { StaffUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = { super_admin: "Super Admin", admin: "Admin", staff: "Staff" };

// super_admin-only read view of staff. Add/deactivate flows are v2-parity (stub).
export default async function StaffPage() {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  if (staff.role !== "super_admin") redirect("/admin/buyers");

  const admin = createAdminClient();
  const { data } = await admin.from("staff_users").select("*").order("created_at");
  const rows = (data ?? []) as StaffUser[];

  return (
    <div className="px-4 md:px-8 py-6">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Staff</h1>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 420 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              {["Name", "Email", "Role", "Active"].map((h) => (
                <th key={h} className="font-body uppercase text-left" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige, padding: "8px 10px", fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <td className="font-body" style={{ fontSize: 13, color: palette.black, padding: "10px" }}>{s.name ?? "—"}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{s.email}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{ROLE_LABEL[s.role]}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{s.active ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-body mt-4" style={{ fontSize: 11, color: palette.mutedGreige }}>Add / deactivate staff is v2-parity — not in the v2.2 scope.</p>
    </div>
  );
}

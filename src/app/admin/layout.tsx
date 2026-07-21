import { redirect } from "next/navigation";
import { getStaff } from "@/lib/staff";
import { AdminShell } from "@/components/admin/AdminShell";
import { OfflineSync } from "@/components/OfflineSync";

export const dynamic = "force-dynamic";

// Middleware already gates /admin/* to active staff; this adds the chrome and a
// defensive re-check. OfflineSync mounts HERE (not just inside the wizard) so
// queued captures/orders stay visible and keep draining after the session
// screen is left — previously they sat invisible in IndexedDB forever.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  return (
    <AdminShell staff={{ name: staff.name, email: staff.email, role: staff.role }}>
      {children}
      <OfflineSync />
    </AdminShell>
  );
}

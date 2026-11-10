import { redirect } from "next/navigation";
import { lookupStaff } from "@/lib/staff";
import { AppShell } from "@/components/shell/AppShell";
import { OfflineSync } from "@/components/OfflineSync";
import { StaffRetry } from "@/components/StaffRetry";

export const dynamic = "force-dynamic";

// Middleware already gates /admin/* to active staff; this adds the chrome and a
// defensive re-check. OfflineSync mounts HERE (not just inside the wizard) so
// queued captures/orders stay visible and keep draining after the session
// screen is left — previously they sat invisible in IndexedDB forever.
//
// A failed lookup is not "signed out": middleware fails open on the same blip,
// and redirecting here is what used to bounce staff to /login. The layout
// shows a retry screen in place of the page. On in-app navigation this layout
// does not re-run, so the page gates (requireStaffOrRedirect and
// requireAdminOrRedirect) throw for the same case and admin/error.tsx shows it.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const res = await lookupStaff();
  if (res.kind === "error") return <StaffRetry />;
  if (res.kind === "none") redirect("/login");
  const { staff } = res;
  return (
    <AppShell staff={{ name: staff.name, email: staff.email, role: staff.role }}>
      {children}
      <OfflineSync />
    </AppShell>
  );
}

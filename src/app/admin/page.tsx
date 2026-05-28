import { redirect } from "next/navigation";
import { getStaff, isAdminRole } from "@/lib/staff";

export const dynamic = "force-dynamic";

export default async function AdminIndex() {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  // Admins land on Buyers; plain staff only have Exhibitions (spec §5).
  redirect(isAdminRole(staff.role) ? "/admin/buyers" : "/admin/exhibition");
}

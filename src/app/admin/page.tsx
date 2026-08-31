import { redirect } from "next/navigation";
import { getStaff } from "@/lib/staff";

export const dynamic = "force-dynamic";

export default async function AdminIndex() {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  // Stage 2: everyone lands on the Home cockpit (build guide §6.3) — today's
  // money, the needs-you inbox, and one-tap quick actions incl. price check.
  redirect("/admin/home");
}

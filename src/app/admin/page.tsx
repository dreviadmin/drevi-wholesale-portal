import { redirect } from "next/navigation";
import { requireStaffOrRedirect } from "@/lib/staff";

export const dynamic = "force-dynamic";

export default async function AdminIndex() {
  // The shared gate, not a hand-rolled getStaff() check: getStaff() returns
  // null when the lookup itself failed, which used to send a signed-in person
  // to /login. The gate throws instead, so admin/error.tsx offers a retry.
  await requireStaffOrRedirect();
  // Stage 2: everyone lands on the Home cockpit (build guide §6.3) — today's
  // money, the needs-you inbox, and one-tap quick actions incl. price check.
  redirect("/admin/home");
}

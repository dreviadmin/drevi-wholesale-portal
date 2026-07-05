import { redirect } from "next/navigation";
import { getStaff } from "@/lib/staff";

export const dynamic = "force-dynamic";

export default async function AdminIndex() {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  // Every staff role lands on the shop-floor price check — the page that has
  // to be reachable fastest when a client is standing at the rack. Everything
  // else is one tap away in the nav.
  redirect("/admin/price-check");
}

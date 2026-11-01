import { requireAdminOrRedirect } from "@/lib/staff";
import { loadDashboardData } from "./load";
import { DashboardView } from "./DashboardView";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Admin dashboard: the day's money at a glance, orders sliced by product /
// vendor / customer, and the reorder table (vendor name + vendor SKU + last
// cost from the wholesale sheet) Rakesh uses to phone vendors for restock.
// Tapping a row narrows the whole page to it.
export default async function DashboardPage() {
  await requireAdminOrRedirect();
  const data = await loadDashboardData();
  return <DashboardView {...data} />;
}

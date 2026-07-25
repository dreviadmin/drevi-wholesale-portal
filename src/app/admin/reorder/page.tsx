import { requireAdminOrRedirect } from "@/lib/staff";
import { loadDashboardData } from "../dashboard/load";
import { DashboardView } from "../dashboard/DashboardView";

export const dynamic = "force-dynamic";

// Stock-space home for the Reorder table (build guide §6.1) — the dashboard's
// Reorder view given its own route so scan/cockpit deep-links land filtered.
export default async function ReorderPage() {
  await requireAdminOrRedirect();
  const data = await loadDashboardData();
  return <DashboardView {...data} initialTab="reorder" />;
}

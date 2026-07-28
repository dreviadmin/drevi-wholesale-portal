import { requireAdminOrRedirect } from "@/lib/staff";
import { reconcile } from "@/lib/stock-ledger";
import { DriftReport } from "./DriftReport";

export const dynamic = "force-dynamic";

// Retrofit R8 §10.3 — the drift report screen. Same data as
// /api/admin/stock-reconcile, rendered with the two correction actions.
export default async function StockCheckPage() {
  await requireAdminOrRedirect();
  const { checked, drift } = await reconcile();
  return <DriftReport checked={checked} rows={drift} />;
}

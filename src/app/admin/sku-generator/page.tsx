import { requireStaff, isAdminRole } from "@/lib/staff";
import { SkuGeneratorClient } from "./SkuGeneratorClient";

export const dynamic = "force-dynamic";

// SKU Registry & Generator (Phase 1, replaces the Apps Script tool). Open to
// every staff role; the duplicate-variant → Goods Receipt deep link renders
// for admins only (receipts are admin-only).
export default async function SkuGeneratorPage() {
  const staff = await requireStaff();
  return <SkuGeneratorClient isAdmin={isAdminRole(staff.role)} />;
}

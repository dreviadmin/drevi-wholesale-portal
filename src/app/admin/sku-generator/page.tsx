import { requireStaff, isAdminRole } from "@/lib/staff";
import { SkuGeneratorClient } from "./SkuGeneratorClient";
import { loadVocab } from "@/lib/sku/vocab-live";

export const dynamic = "force-dynamic";

// SKU Registry & Generator (Phase 1, replaces the Apps Script tool). Open to
// every staff role; the duplicate-variant → Goods Receipt deep link renders
// for admins only (receipts are admin-only). `?tab=print` is the Log delivery
// hand-off — read on the server so the Print tab renders without a flash.
export default async function SkuGeneratorPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const staff = await requireStaff();
  const initialTab = searchParams?.tab === "print" ? "print" : "generate";
  return <SkuGeneratorClient isAdmin={isAdminRole(staff.role)} vocab={await loadVocab()} initialTab={initialTab} />;
}

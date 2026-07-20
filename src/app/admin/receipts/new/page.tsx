import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { ReceiptEditor } from "../ReceiptEditor";

export const dynamic = "force-dynamic";

// New goods receipt. Accepts ?sku= prefill from the duplicate-variant deep
// link on the SKU generator.
export default async function NewReceiptPage({ searchParams }: { searchParams: { sku?: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  const [{ data: vendors }, { data: skus }] = await Promise.all([
    admin.from("vendors").select("id, name, city").eq("active", true).order("name"),
    admin.from("sku_registry").select("variant_sku"),
  ]);

  return (
    <div className="px-4 md:px-6 py-5 max-w-2xl">
      <Link href="/admin/receipts" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: "#998F7A" }}>
        <ChevronLeft size={14} /> Receipts
      </Link>
      <h1 className="font-display mt-3" style={{ fontSize: 22, fontWeight: 600, color: "#1A1A1A" }}>New Goods Receipt</h1>
      <ReceiptEditor
        vendors={(vendors ?? []).map((v) => ({ id: v.id, name: v.name, city: v.city }))}
        registrySkus={(skus ?? []).map((s) => s.variant_sku as string)}
        prefillSku={searchParams.sku?.trim() || undefined}
      />
    </div>
  );
}

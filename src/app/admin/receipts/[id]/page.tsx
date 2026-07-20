import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedReceiptPhotoUrl } from "@/lib/storage";
import { ReceiptDetail } from "./ReceiptDetail";

export const dynamic = "force-dynamic";

export default async function ReceiptDetailPage({ params }: { params: { id: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  const { data: rec } = await admin.from("goods_receipts").select("*").eq("id", params.id).maybeSingle();
  if (!rec) notFound();

  const [{ data: lines }, { data: vendor }, { data: vendors }, { data: skus }] = await Promise.all([
    admin.from("goods_receipt_lines").select("*").eq("receipt_id", params.id).order("position"),
    admin.from("vendors").select("id, name, city").eq("id", rec.vendor_id).maybeSingle(),
    admin.from("vendors").select("id, name, city").eq("active", true).order("name"),
    admin.from("sku_registry").select("variant_sku"),
  ]);
  const billUrl = rec.bill_photo_path ? await signedReceiptPhotoUrl(rec.bill_photo_path) : null;

  return (
    <div className="px-4 md:px-6 py-5 max-w-2xl">
      <Link href="/admin/receipts" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: "#998F7A" }}>
        <ChevronLeft size={14} /> Receipts
      </Link>
      <ReceiptDetail
        receipt={{
          id: rec.id,
          number: rec.receipt_number,
          vendorId: rec.vendor_id,
          vendorName: vendor?.name ?? "—",
          vendorCity: vendor?.city ?? null,
          date: rec.receipt_date,
          billAmount: rec.bill_amount != null ? Number(rec.bill_amount) : null,
          notes: rec.notes ?? "",
          billUrl,
          createdBy: rec.created_by,
          createdAt: rec.created_at,
        }}
        lines={(lines ?? []).map((l) => ({
          id: l.id, sku: l.sku, description: l.description ?? "", qty: l.qty, unitCost: Number(l.unit_cost),
        }))}
        vendors={(vendors ?? []).map((v) => ({ id: v.id, name: v.name, city: v.city }))}
        registrySkus={(skus ?? []).map((s) => s.variant_sku as string)}
      />
    </div>
  );
}

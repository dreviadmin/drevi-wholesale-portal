import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { VendorDetail } from "./VendorDetail";

export const dynamic = "force-dynamic";

export default async function VendorDetailPage({ params }: { params: { id: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  const { data: vendor } = await admin.from("vendors").select("*").eq("id", params.id).maybeSingle();
  if (!vendor) notFound();

  const { data: receipts } = await admin
    .from("goods_receipts")
    .select("id, receipt_number, receipt_date, created_by")
    .eq("vendor_id", params.id)
    .order("receipt_date", { ascending: false });
  const receiptIds = (receipts ?? []).map((r) => r.id);
  const { data: lines } = receiptIds.length
    ? await admin.from("goods_receipt_lines").select("receipt_id, qty, unit_cost").in("receipt_id", receiptIds)
    : { data: [] as { receipt_id: string; qty: number; unit_cost: number }[] };

  const totals = new Map<string, { pieces: number; value: number }>();
  for (const l of lines ?? []) {
    const e = totals.get(l.receipt_id) ?? { pieces: 0, value: 0 };
    e.pieces += l.qty;
    e.value += l.qty * Number(l.unit_cost);
    totals.set(l.receipt_id, e);
  }

  return (
    <div className="px-4 md:px-6 py-5 max-w-3xl">
      <Link href="/admin/vendors" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: "#998F7A" }}>
        <ChevronLeft size={14} /> Vendors
      </Link>
      <VendorDetail
        vendor={{
          id: vendor.id, name: vendor.name, phone: vendor.phone, whatsapp: vendor.whatsapp,
          city: vendor.city, gstin: vendor.gstin, address: vendor.address, notes: vendor.notes,
          active: vendor.active, receipts: (receipts ?? []).length, lastReceipt: receipts?.[0]?.receipt_date ?? null,
          skus: [],
        }}
        receipts={(receipts ?? []).map((r) => ({
          id: r.id,
          number: r.receipt_number,
          date: r.receipt_date,
          createdBy: r.created_by,
          pieces: totals.get(r.id)?.pieces ?? 0,
          value: totals.get(r.id)?.value ?? 0,
        }))}
      />
    </div>
  );
}

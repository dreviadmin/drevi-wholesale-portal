import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { VendorsView, type VendorRow } from "./VendorsView";

export const dynamic = "force-dynamic";

// Vendors (Phase 1, admin-only): who supplies what, joined with their goods
// receipts. Cost data never leaves admin surfaces.
export default async function VendorsPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const [{ data: vendors }, { data: receipts }, lines, { data: vendorInfo }] = await Promise.all([
    admin.from("vendors").select("*").order("name"),
    admin.from("goods_receipts").select("id, vendor_id, receipt_date"),
    fetchAll<{ receipt_id: string; sku: string }>(admin, "goods_receipt_lines", "receipt_id, sku"),
    admin.from("product_vendor_info").select("sku, vendor_name"),
  ]);

  const receiptById = new Map((receipts ?? []).map((r) => [r.id, r]));
  const byVendor = new Map<string, { count: number; last: string | null; skus: Set<string> }>();
  for (const r of receipts ?? []) {
    const e = byVendor.get(r.vendor_id) ?? { count: 0, last: null, skus: new Set<string>() };
    e.count += 1;
    if (!e.last || r.receipt_date > e.last) e.last = r.receipt_date;
    byVendor.set(r.vendor_id, e);
  }
  for (const l of lines) {
    const rec = receiptById.get(l.receipt_id);
    if (!rec) continue;
    byVendor.get(rec.vendor_id)?.skus.add((l.sku as string).toUpperCase());
  }

  const rows: VendorRow[] = (vendors ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    phone: v.phone,
    whatsapp: v.whatsapp,
    city: v.city,
    gstin: v.gstin,
    address: v.address,
    notes: v.notes,
    active: v.active,
    receipts: byVendor.get(v.id)?.count ?? 0,
    lastReceipt: byVendor.get(v.id)?.last ?? null,
    skus: Array.from(byVendor.get(v.id)?.skus ?? []),
  }));

  // Scan fallback: sheet vendor names per SKU (normalised match by name).
  const sheetVendorBySku: Record<string, string> = {};
  for (const r of vendorInfo ?? []) {
    if (r.vendor_name?.trim()) sheetVendorBySku[(r.sku as string).toUpperCase()] = r.vendor_name.trim();
  }

  return <VendorsView rows={rows} sheetVendorBySku={sheetVendorBySku} />;
}

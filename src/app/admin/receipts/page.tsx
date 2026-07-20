import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { ReceiptsView, type ReceiptRow } from "./ReceiptsView";

export const dynamic = "force-dynamic";

// Goods Receipts list (admin-only): what came in, from whom, at what cost.
export default async function ReceiptsPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const [{ data: receipts }, { data: vendors }, { data: lines }] = await Promise.all([
    admin.from("goods_receipts").select("id, receipt_number, vendor_id, receipt_date, bill_amount, created_by").order("receipt_date", { ascending: false }),
    admin.from("vendors").select("id, name"),
    admin.from("goods_receipt_lines").select("receipt_id, sku, qty, unit_cost"),
  ]);

  const vendorById = new Map((vendors ?? []).map((v) => [v.id, v.name]));
  const agg = new Map<string, { lines: number; pieces: number; value: number; skus: string[] }>();
  for (const l of lines ?? []) {
    const e = agg.get(l.receipt_id) ?? { lines: 0, pieces: 0, value: 0, skus: [] };
    e.lines += 1;
    e.pieces += l.qty;
    e.value += l.qty * Number(l.unit_cost);
    e.skus.push((l.sku as string).toUpperCase());
    agg.set(l.receipt_id, e);
  }

  const rows: ReceiptRow[] = (receipts ?? []).map((r) => ({
    id: r.id,
    number: r.receipt_number,
    vendor: vendorById.get(r.vendor_id) ?? "—",
    date: r.receipt_date,
    lines: agg.get(r.id)?.lines ?? 0,
    pieces: agg.get(r.id)?.pieces ?? 0,
    value: agg.get(r.id)?.value ?? 0,
    createdBy: r.created_by,
    skusText: (agg.get(r.id)?.skus ?? []).join(" "),
  }));

  return <ReceiptsView rows={rows} vendors={Array.from(new Set(rows.map((r) => r.vendor))).sort()} />;
}

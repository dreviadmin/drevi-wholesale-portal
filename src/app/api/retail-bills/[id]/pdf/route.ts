import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { renderOrderPdf } from "@/lib/order-pdf";
import { billDateToIso } from "@/lib/order-lines-core";
import type { Order, RetailBill } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// On-demand retail-bill PDF (31 Aug). The stored pdf_url is a 30-day signed
// link — this route is the permanent address: regenerates from the bill's own
// snapshot every time, so it never expires and never drifts from the record.
// Staff only (retail customers get the file handed to them, not a login).
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try { await requireStaff(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const admin = createAdminClient();
  const { data: bill } = await admin.from("retail_bills").select("*").eq("id", params.id).maybeSingle();
  if (!bill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = bill as RetailBill;

  const synthetic = {
    order_number: b.bill_number,
    source: "in_store",
    items: b.items,
    total_amount: b.total,
    discount_type: b.discount_type,
    discount_value: b.discount_value,
    discount_amount: b.discount_amount,
    tax_mode: b.tax_mode,
    tax_rate: b.tax_rate,
    tax_amount: b.tax_amount,
    advance_amount: 0,
    payment_method: b.payment_method,
    notes: null,
    submitted_at: billDateToIso(b.bill_date),
  } as unknown as Order;

  const pdf = await renderOrderPdf(
    synthetic,
    { business_name: b.customer_name || "Retail Customer", owner_name: null, phone: b.customer_phone, city: null },
    undefined,
    { tagline: "RETAIL - INVOICE", metaLine: b.voided_at ? "Retail sale — VOIDED" : "Retail sale" },
  );
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${b.bill_number}.pdf"`,
    },
  });
}

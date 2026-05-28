import { NextResponse } from "next/server";
import { renderOrderPdf } from "@/lib/order-pdf";
import type { Order } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dev-only: render a synthetic order PDF exercising all four stock states.
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }
  const order: Order = {
    id: "test",
    order_number: "DW-20260529-TEST",
    buyer_id: "test",
    status: "submitted",
    source: "exhibition",
    assisted_by: null,
    exhibition_event: "Bridal Asia 2026",
    items: [
      { sku: "DD-LEH-001", title: "Sage Heirloom Lehenga", unit_price: 4200, qty: 2, stock_state: "ready", restock_days: null },
      { sku: "DD-IWS-002", title: "Maroon Velvet Co-ord", unit_price: 2500, qty: 1, stock_state: "limited", restock_days: null },
      { sku: "DD-SAR-003", title: "Noir Sequined Saree Gown", unit_price: 5400, qty: 1, stock_state: "made_to_order", restock_days: 14 },
      { sku: "DD-LEH-004", title: "Charcoal Velvet Lehenga", unit_price: 9800, qty: 1, stock_state: "sold_out", restock_days: null },
    ],
    total_amount: 4200 * 2 + 2500 + 5400 + 9800,
    notes: "Customer wants the lehenga in time for the showcase.",
    pdf_url: null,
    pdf_sent_via: null,
    pdf_sent_at: null,
    submitted_at: new Date().toISOString(),
    confirmed_at: null,
  };
  const pdf = await renderOrderPdf(order, { business_name: "Sharma Boutique", owner_name: "Meera Sharma", phone: "+919812345678", city: "Pune" });
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="test.pdf"' },
  });
}

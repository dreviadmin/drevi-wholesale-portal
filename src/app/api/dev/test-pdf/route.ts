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
  // Exercises the full invoice: four stock states, a price override, a special
  // request, a percent discount, exclusive GST, and an advance payment.
  const subtotal = 4000 * 2 + 2500 + 5400 + 9800; // one line overridden 4200→4000
  const discount = Math.round(subtotal * 0.1 * 100) / 100;
  const net = subtotal - discount;
  const tax = Math.round(net * 0.12 * 100) / 100;
  const order: Order = {
    id: "test",
    order_number: "IS-20260529-TEST",
    buyer_id: "test",
    status: "submitted",
    source: "in_store",
    assisted_by: null,
    exhibition_event: "In-store",
    items: [
      { sku: "DD-LEH-001", title: "Sage Heirloom Lehenga", unit_price: 4000, original_price: 4200, qty: 2, stock_state: "ready", restock_days: null },
      { sku: "DD-IWS-002", title: "Maroon Velvet Co-ord", unit_price: 2500, qty: 1, stock_state: "limited", restock_days: null, special_request: true },
      { sku: "DD-SAR-003", title: "Noir Sequined Saree Gown", unit_price: 5400, qty: 1, stock_state: "made_to_order", restock_days: 14 },
      { sku: "DD-LEH-004", title: "Charcoal Velvet Lehenga", unit_price: 9800, qty: 1, stock_state: "sold_out", restock_days: null },
    ],
    total_amount: net + tax,
    discount_type: "percent",
    discount_value: 10,
    discount_amount: discount,
    tax_mode: "exclusive",
    tax_rate: 12,
    tax_amount: tax,
    advance_amount: 10000,
    payment_method: "UPI",
    payment_notes: null,
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

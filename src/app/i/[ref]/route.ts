import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { freshOrderPdfUrl } from "@/lib/storage";
import { WHOLESALE_PHONE } from "@/lib/contact";

// /i/<order id or bill id> — the permanent invoice link buyers get on WhatsApp
// (src/lib/invoice-link.ts). Public by design, like the one-tap login links:
// the id is unguessable and the link only ever shows that one PDF. Each open
// signs a fresh short-lived storage link and redirects to it, so the link the
// buyer saved keeps working however old it is.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, body: string, status: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Drevi</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FAF6F0;color:#1A1A1A;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
main{max-width:420px;text-align:center}.brand{letter-spacing:.4em;font:600 22px Georgia,serif;margin-bottom:24px}h1{font:600 20px Georgia,serif;margin:0 0 8px}p{margin:0 0 6px;color:#4A433B}</style></head>
<body><main><div class="brand">DREVI</div><h1>${title}</h1><p>${body}</p><p>WhatsApp Drevi on ${WHOLESALE_PHONE}.</p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

export async function GET(_req: Request, { params }: { params: { ref: string } }) {
  const ref = params.ref ?? "";
  if (!UUID.test(ref)) return page("Invoice not found", "This link is not complete. Please ask us for the invoice again.", 404);

  const admin = createAdminClient();
  let file: { orderId: string; number: string } | null = null;
  const { data: bill } = await admin.from("order_bills").select("order_id, bill_number, cancelled_at").eq("id", ref).maybeSingle();
  if (bill) {
    if (bill.cancelled_at) return page("This bill was cancelled", `Bill ${bill.bill_number} is no longer valid. Please ask us for the current invoice.`, 410);
    file = { orderId: bill.order_id, number: bill.bill_number };
  } else {
    const { data: order } = await admin.from("orders").select("id, order_number").eq("id", ref).maybeSingle();
    if (order) file = { orderId: order.id, number: order.order_number };
  }
  if (!file) return page("Invoice not found", "We could not find this invoice. Please ask us for it again.", 404);

  const url = await freshOrderPdfUrl(file.orderId, file.number, 60 * 10);
  if (!url) return page("Invoice not ready", `The PDF for ${file.number} is not ready yet. Please ask us to send it again.`, 404);
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

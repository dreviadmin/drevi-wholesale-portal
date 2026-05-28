import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { renderOrderPdf } from "@/lib/order-pdf";
import { uploadOrderPdf } from "@/lib/storage";
import { sendOrderConfirmation, sendOrderAlert } from "@/lib/interakt";
import { formatINR } from "@/lib/format";
import type { Order } from "@/lib/types";

// Best-effort post-submit: render the PDF, upload it, store the URL, and fire
// the buyer confirmation + Rakesh alert. Any failure is swallowed — the order
// already exists and the PDF is reachable via the on-demand download route.
export async function finalizeOrder(orderId: string): Promise<void> {
  const admin = createAdminClient();
  try {
    const { data: order } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
    if (!order) return;
    const o = order as Order;
    const { data: buyer } = await admin
      .from("buyers")
      .select("business_name, owner_name, phone, city")
      .eq("id", o.buyer_id)
      .maybeSingle();

    const pdf = await renderOrderPdf(o, buyer ?? { business_name: null, owner_name: null, phone: null, city: null });
    const url = await uploadOrderPdf(o.id, o.order_number, pdf);
    await admin.from("orders").update({ pdf_url: url }).eq("id", o.id);

    const total = formatINR(o.total_amount);
    const conf = buyer?.phone
      ? await sendOrderConfirmation(buyer.phone, o.order_number, total, url)
      : { sent: false };
    await sendOrderAlert(o.order_number, buyer?.business_name ?? "-", total, o.source === "exhibition" ? "Exhibition" : "Portal");

    if (conf.sent) {
      await admin.from("orders").update({ pdf_sent_via: conf.channel ?? "whatsapp", pdf_sent_at: new Date().toISOString() }).eq("id", o.id);
    }
  } catch (e) {
    console.error("finalizeOrder failed (order stands; download fallback available):", (e as Error).message);
  }
}

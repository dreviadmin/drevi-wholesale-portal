import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { renderOrderPdf } from "@/lib/order-pdf";
import { resolveDocumentParty } from "@/lib/buyer-snapshot";
import { uploadOrderPdf } from "@/lib/storage";
import { sendOrderConfirmation, sendOrderAlert } from "@/lib/interakt";
import { formatINR } from "@/lib/format";
import type { Order } from "@/lib/types";

// Best-effort post-submit: render the PDF, upload it, store the URL, and (unless
// suppressed) fire the buyer confirmation + Rakesh alert. Any failure is
// swallowed — the order already exists and the PDF is reachable via the
// on-demand download route.
//
// `notify` defaults to true (initial submission). Edits pass notify:false so a
// staff correction regenerates the invoice PDF silently instead of pinging the
// buyer a fresh "order confirmed, total ₹X" message for every tweak.
export async function finalizeOrder(orderId: string, opts: { notify?: boolean } = {}): Promise<void> {
  const notify = opts.notify ?? true;
  const admin = createAdminClient();
  try {
    const { data: order } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
    if (!order) return;
    const o = order as Order;
    // This overwrites the stored file at orders.pdf_url, so it has to reprint
    // the party frozen at submission — a live read here would let one edit to a
    // buyers row rewrite the invoice held against every past order.
    const party = await resolveDocumentParty(admin, o, o.buyer_id);

    const pdf = await renderOrderPdf(o, party);
    const url = await uploadOrderPdf(o.id, o.order_number, pdf);
    await admin.from("orders").update({ pdf_url: url }).eq("id", o.id);

    if (!notify) return;

    // A DOCUMENT prints who the party was; a MESSAGE has to reach who they are
    // now. "Send Invoice" can fire months after submission, by which time the
    // frozen number may be dead, so delivery reads the buyers row live.
    const { data: contact } = await admin.from("buyers").select("phone").eq("id", o.buyer_id).maybeSingle();
    const phone = contact?.phone ?? party.phone;

    const total = formatINR(o.total_amount);
    const conf = phone
      ? await sendOrderConfirmation(phone, o.order_number, total, url)
      : { sent: false };
    await sendOrderAlert(o.order_number, party.business_name ?? "-", total, o.source === "exhibition" ? "Exhibition" : "Portal");

    if (conf.sent) {
      await admin.from("orders").update({ pdf_sent_via: conf.channel ?? "whatsapp", pdf_sent_at: new Date().toISOString() }).eq("id", o.id);
    }
  } catch (e) {
    console.error("finalizeOrder failed (order stands; download fallback available):", (e as Error).message);
  }
}

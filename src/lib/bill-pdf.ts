import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { renderOrderPdf } from "@/lib/order-pdf";
import { uploadOrderPdf } from "@/lib/storage";
import { pendingLines, billDateToIso } from "@/lib/order-lines-core";
import type { BuyerParty } from "@/lib/buyer-snapshot";
import type { Order, OrderBill } from "@/lib/types";

/** A bill as stored — everything renderOrderPdf needs, nothing recomputed. */
export type BillForPdf = Pick<
  OrderBill,
  "id" | "bill_number" | "seq" | "bill_date" | "items" | "discount_amount" | "tax_mode" | "tax_rate" | "tax_amount" | "total" | "advance_applied"
>;

/**
 * Render + store one bill's PDF. Best-effort: the bill row already stands, so a
 * failure never rolls anything back — but it is now REPORTED (30 Sep): the
 * caller gets the reason and the order page offers "Make PDF", instead of a
 * "generated" toast over a bill with no file. Lives outside the "use server"
 * actions file so it is not itself callable from a browser, and so scripts can
 * reuse it.
 */
export async function renderAndStoreBillPdf(order: Order, bill: BillForPdf, party: BuyerParty): Promise<{ url?: string; error?: string }> {
  const admin = createAdminClient();
  try {
    const after = { ...order, items: (await admin.from("orders").select("items").eq("id", order.id).single()).data?.items ?? order.items };
    const synthetic: Order = {
      ...order,
      order_number: bill.bill_number,
      items: bill.items,
      total_amount: bill.total,
      discount_type: bill.discount_amount > 0 ? order.discount_type : null,
      discount_value: bill.discount_amount > 0 ? order.discount_value : null,
      discount_amount: bill.discount_amount,
      tax_mode: bill.tax_mode,
      tax_rate: bill.tax_rate,
      tax_amount: bill.tax_amount,
      advance_amount: bill.advance_applied,
      submitted_at: billDateToIso(bill.bill_date),
    };
    const pdf = await renderOrderPdf(synthetic, party, {
      seq: bill.seq,
      orderNumber: order.order_number,
      pendingCount: pendingLines(after as Order).length,
    });
    const url = await uploadOrderPdf(order.id, bill.bill_number, pdf);
    await admin.from("order_bills").update({ pdf_url: url }).eq("id", bill.id);
    return { url };
  } catch (e) {
    const error = (e as Error).message;
    console.error("bill PDF failed (bill stands; Make PDF on the order page retries):", error);
    return { error };
  }
}

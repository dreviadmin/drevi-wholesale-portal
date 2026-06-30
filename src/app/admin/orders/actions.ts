"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/staff";
import { finalizeOrder } from "@/lib/order-finalize";
import type { OrderStatus } from "@/lib/types";

export async function setOrderStatus(
  orderId: string,
  status: OrderStatus,
  options?: { sendInvoice?: boolean },
): Promise<{ ok: boolean; error?: string; invoiceSent?: boolean }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  const admin = createAdminClient();
  const patch: Record<string, unknown> = { status };
  if (status === "confirmed") patch.confirmed_at = new Date().toISOString();
  const { error } = await admin.from("orders").update(patch).eq("id", orderId);
  if (error) return { ok: false, error: error.message };
  let invoiceSent = false;
  if (options?.sendInvoice) {
    await finalizeOrder(orderId); // best-effort: PDF + Interakt confirmation
    const { data } = await admin.from("orders").select("pdf_sent_at").eq("id", orderId).maybeSingle();
    invoiceSent = !!data?.pdf_sent_at;
  }
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, invoiceSent };
}

// Re-fire the PDF generation + Interakt confirmation send. Used by the
// "Send Invoice" button. Graceful no-op without INTERAKT_API_KEY (PDF still
// regenerated + stored).
export async function sendInvoice(orderId: string): Promise<{ ok: boolean; sent?: boolean; error?: string }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized." };
  }
  await finalizeOrder(orderId);
  const admin = createAdminClient();
  const { data } = await admin.from("orders").select("pdf_sent_at, pdf_url").eq("id", orderId).maybeSingle();
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, sent: !!data?.pdf_sent_at };
}

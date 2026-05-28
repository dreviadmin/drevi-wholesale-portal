"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/staff";
import type { OrderStatus } from "@/lib/types";

export async function setOrderStatus(orderId: string, status: OrderStatus): Promise<{ ok: boolean; error?: string }> {
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
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true };
}

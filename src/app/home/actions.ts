"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";

// Buyer-side actions (§13). Buyer resolution mirrors the login rule: the
// CREDENTIALED row for the signed-in email, active only.

async function currentBuyer(): Promise<{ id: string } | null> {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("buyers")
    .select("id, status")
    .eq("email", user.email)
    .not("encrypted_password", "is", null)
    .limit(1);
  return rows?.[0]?.status === "active" ? { id: rows[0].id } : null;
}

// "Notify me" on a sold-out card. Parses DD-CAT-SUB-NNN-SIZE-COLOR → group.
export async function notifyMe(sku: string): Promise<{ ok: boolean; error?: string }> {
  const buyer = await currentBuyer();
  if (!buyer) return { ok: false, error: "Sign in as a buyer first" };
  const parts = sku.trim().toUpperCase().split("-");
  if (parts.length < 5 || !/^\d{2,4}$/.test(parts[3])) return { ok: false, error: "Unknown SKU shape" };
  const skuBase = parts.slice(0, 4).join("-");
  const color = parts[parts.length - 1];
  const admin = createAdminClient();
  const { error } = await admin.from("notify_me").insert({ buyer_id: buyer.id, sku_base: skuBase, color });
  if (error && error.code !== "23505") return { ok: false, error: error.message };
  revalidatePath("/home");
  return { ok: true };
}

// The strip's dismiss: mark the request fulfilled once the buyer has seen it.
export async function dismissNotify(sku: string): Promise<{ ok: boolean }> {
  const buyer = await currentBuyer();
  if (!buyer) return { ok: false };
  const parts = sku.trim().toUpperCase().split("-");
  if (parts.length < 5) return { ok: false };
  const admin = createAdminClient();
  await admin
    .from("notify_me")
    .update({ fulfilled_at: new Date().toISOString() })
    .eq("buyer_id", buyer.id)
    .eq("sku_base", parts.slice(0, 4).join("-"))
    .eq("color", parts[parts.length - 1])
    .is("fulfilled_at", null);
  revalidatePath("/home");
  return { ok: true };
}

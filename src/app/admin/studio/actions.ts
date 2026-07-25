"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";

// Stage 3's two LIVE batch actions (§7.4). Spend/push actions arrive with
// Stages 4–7 — their buttons render disabled until then.

export async function setTierBatch(designIds: string[], tier: "standard" | "hero"): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const admin = createAdminClient();
  const { error } = await admin.from("designs").update({ tier, updated_at: new Date().toISOString() }).in("id", designIds.slice(0, 500));
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({
    eventType: "studio_tier_set",
    staffUserId: staff.id,
    notes: `tier=${tier} on ${designIds.length} design(s)`,
  });
  revalidatePath("/admin/studio");
  return { ok: true };
}

export async function togglePortalBatch(
  designIds: string[],
  portal: "wholesale" | "shopify",
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const admin = createAdminClient();
  const { error } = await admin
    .from("publish_targets")
    .update({ enabled })
    .eq("portal", portal)
    .in("design_id", designIds.slice(0, 500));
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({
    eventType: "studio_portal_toggled",
    staffUserId: staff.id,
    notes: `${portal} ${enabled ? "enabled" : "disabled"} on ${designIds.length} design(s)`,
  });
  revalidatePath("/admin/studio");
  return { ok: true };
}

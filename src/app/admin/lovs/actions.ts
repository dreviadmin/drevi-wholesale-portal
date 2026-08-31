"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import type { AuditEventType } from "@/lib/types";

const LISTS = ["category", "sub_category", "color", "size", "fabric", "occasion"] as const;
export type LovList = (typeof LISTS)[number];

type Res = { ok: boolean; error?: string };

export async function upsertLov(input: {
  id?: string;
  list: LovList;
  code: string;
  label?: string;
  sort?: number;
  active?: boolean;
}): Promise<Res & { id?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  if (!LISTS.includes(input.list)) return { ok: false, error: "Unknown list." };
  const code = input.code.trim().toUpperCase();
  if (!code || code.length > 24) return { ok: false, error: "Code is required (max 24 chars)." };

  const admin = createAdminClient();
  const row = {
    list: input.list,
    code,
    label: input.label?.trim() || code,
    sort: Number.isFinite(input.sort) ? Math.trunc(input.sort!) : 0,
    active: input.active ?? true,
  };
  const { data, error } = input.id
    ? await admin.from("lovs").update(row).eq("id", input.id).select("id").single()
    : await admin.from("lovs").upsert(row, { onConflict: "list,code" }).select("id").single();
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "catalog_edit" as AuditEventType, staffUserId: staff.id, notes: `lov ${input.list}:${code}` });
  revalidatePath("/admin/lovs");
  return { ok: true, id: data.id };
}

/** Deactivate, never delete — codes may be referenced by existing SKUs. */
export async function setLovActive(id: string, active: boolean): Promise<Res> {
  try { await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { error } = await admin.from("lovs").update({ active }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/lovs");
  return { ok: true };
}

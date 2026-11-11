import "server-only";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import type { StaffCtx } from "@/lib/staff";
import { escapeIlike, findVendorByName } from "@/lib/vendor-name";

// "+ New vendor" from a receipt: the one implementation behind both the
// receipt editor and Log delivery, which used to differ. A name that already
// exists (any case) selects that vendor instead of failing on the unique
// index, and a vendor that was switched off is switched back on rather than
// staying hidden from both pickers. Callers check the staff role first.

export type QuickAddVendorResult =
  | { ok: true; id: string; name: string; kind: "created" | "found" | "reactivated" }
  | { ok: false; error: string };

type Admin = ReturnType<typeof createAdminClient>;
type VendorRow = { id: string; name: string; active: boolean };

async function lookup(admin: Admin, name: string): Promise<{ row?: VendorRow; error?: string }> {
  const { data, error } = await admin.from("vendors").select("id, name, active").ilike("name", escapeIlike(name));
  if (error) return { error: error.message };
  return { row: findVendorByName((data ?? []) as VendorRow[], name) };
}

async function adoptExisting(admin: Admin, row: VendorRow, staff: Pick<StaffCtx, "id">): Promise<QuickAddVendorResult> {
  if (row.active) return { ok: true, id: row.id, name: row.name, kind: "found" };
  const { error } = await admin.from("vendors").update({ active: true, updated_at: new Date().toISOString() }).eq("id", row.id);
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({ eventType: "vendor_updated", staffUserId: staff.id, notes: `reactivated ${row.name}` });
  revalidatePath("/admin/vendors");
  revalidatePath(`/admin/vendors/${row.id}`);
  return { ok: true, id: row.id, name: row.name, kind: "reactivated" };
}

export async function quickAddVendorCore(name: string, phone: string | undefined, staff: Pick<StaffCtx, "id">): Promise<QuickAddVendorResult> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Vendor name is required." };
  const admin = createAdminClient();

  const found = await lookup(admin, clean);
  if (found.error) return { ok: false, error: found.error };
  if (found.row) return adoptExisting(admin, found.row, staff);

  const { data, error } = await admin
    .from("vendors")
    .insert({ name: clean, phone: phone?.trim() || null, active: true })
    .select("id, name")
    .single();
  if (error) {
    // Someone added the same name a moment ago: answer as if it had been there.
    if (error.code === "23505") {
      const again = await lookup(admin, clean);
      if (again.row) return adoptExisting(admin, again.row, staff);
      return { ok: false, error: `A vendor named "${clean}" already exists.` };
    }
    return { ok: false, error: error.message };
  }
  await writeAuditEvent({ eventType: "vendor_created", staffUserId: staff.id, notes: data.name });
  revalidatePath("/admin/vendors");
  return { ok: true, id: data.id, name: data.name, kind: "created" };
}

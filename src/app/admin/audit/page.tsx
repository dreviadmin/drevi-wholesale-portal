import { redirect } from "next/navigation";
import { getStaff, isAdminRole } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { AuditTable, type AuditRowDTO } from "./AuditTable";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  if (!isAdminRole(staff.role)) redirect("/admin/buyers"); // admin / super_admin only (spec §5)

  const admin = createAdminClient();
  const { data: events } = await admin
    .from("auth_audit_log")
    .select("event_type, event_at, buyer_id, staff_user_id, notes, ip_address")
    .order("event_at", { ascending: false })
    .limit(300);

  const buyerIds = Array.from(new Set((events ?? []).map((e) => e.buyer_id).filter(Boolean) as string[]));
  const [{ data: buyers }, { data: staffRows }] = await Promise.all([
    buyerIds.length ? admin.from("buyers").select("id, business_name").in("id", buyerIds) : Promise.resolve({ data: [] as { id: string; business_name: string | null }[] }),
    admin.from("staff_users").select("id, name"),
  ]);
  const buyerName = new Map((buyers ?? []).map((b) => [b.id, b.business_name ?? "—"]));
  const staffName = new Map((staffRows ?? []).map((s) => [s.id, s.name ?? "Staff"]));

  const rows: AuditRowDTO[] = (events ?? []).map((e) => ({
    event_type: e.event_type,
    event_at: e.event_at,
    buyer: e.buyer_id ? buyerName.get(e.buyer_id) ?? "—" : "—",
    staff: e.staff_user_id ? staffName.get(e.staff_user_id) ?? "Staff" : "—",
    notes: e.notes,
    ip: e.ip_address,
  }));

  return <AuditTable rows={rows} />;
}

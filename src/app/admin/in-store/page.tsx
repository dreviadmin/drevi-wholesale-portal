import { requireStaff } from "@/lib/staff";
import { AutoRefresh } from "@/components/AutoRefresh";
import { createAdminClient } from "@/lib/supabase/admin";
import { SessionHome } from "@/components/admin/SessionHome";

export const dynamic = "force-dynamic";

export default async function InStorePage() {
  await requireStaff();
  const admin = createAdminClient();
  const { data: sessions } = await admin
    .from("exhibition_sessions")
    .select("id, event_name, started_at, ended_at, orders_count, session_type")
    .eq("session_type", "in_store")
    .order("started_at", { ascending: false })
    .limit(10);
  return (<><AutoRefresh /><SessionHome type="in_store" basePath="/admin/in-store" sessions={sessions ?? []} /></>);
}

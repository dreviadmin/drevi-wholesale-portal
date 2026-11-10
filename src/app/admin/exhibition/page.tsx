import { requireStaffOrRedirect } from "@/lib/staff";
import { AutoRefresh } from "@/components/AutoRefresh";
import { createAdminClient } from "@/lib/supabase/admin";
import { SessionHome } from "@/components/admin/SessionHome";

export const dynamic = "force-dynamic";

export default async function ExhibitionPage() {
  await requireStaffOrRedirect();
  const admin = createAdminClient();
  // null session_type = rows that predate the in-store split — all exhibitions.
  const { data: sessions } = await admin
    .from("exhibition_sessions")
    .select("id, event_name, started_at, ended_at, orders_count, session_type")
    .or("session_type.eq.exhibition,session_type.is.null")
    .order("started_at", { ascending: false })
    .limit(10);
  return (<><AutoRefresh /><SessionHome type="exhibition" basePath="/admin/exhibition" sessions={sessions ?? []} /></>);
}

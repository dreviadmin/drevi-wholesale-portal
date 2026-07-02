import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { ExhibitionHome } from "./ExhibitionHome";

export const dynamic = "force-dynamic";

export default async function ExhibitionPage() {
  await requireStaff();
  const admin = createAdminClient();
  const { data: sessions } = await admin
    .from("exhibition_sessions")
    .select("id, event_name, started_at, ended_at, orders_count, session_type")
    .order("started_at", { ascending: false })
    .limit(10);
  return <ExhibitionHome sessions={sessions ?? []} />;
}

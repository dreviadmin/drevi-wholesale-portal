import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// UX sprint (29 Jul, Ansh): in-store billing needs NO session ceremony — the
// order timestamp is enough. One permanent "Walk-in counter" session backs the
// wizard (drafts, order numbering and reporting all key off a session id), and
// this page just drops staff straight into it. Exhibitions keep real sessions
// — those are genuine multi-day events with a start and an end.
export default async function InStorePage() {
  await requireStaff();
  const admin = createAdminClient();

  const { data: open } = await admin
    .from("exhibition_sessions")
    .select("id")
    .eq("session_type", "in_store")
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let id = open?.id;
  if (!id) {
    const { data: created, error } = await admin
      .from("exhibition_sessions")
      .insert({ event_name: "Walk-in counter", session_type: "in_store" })
      .select("id")
      .single();
    if (error) throw new Error(`Could not open the walk-in counter: ${error.message}`);
    id = created.id;
  }
  redirect(`/admin/in-store/${id}`);
}

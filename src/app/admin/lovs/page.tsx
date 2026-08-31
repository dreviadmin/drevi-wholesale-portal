import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { LovsEditor, type LovRow } from "./LovsEditor";

export const dynamic = "force-dynamic";

// Lists of values (Ansh's plan §2, decision 5): categories, sub-categories,
// colours, sizes, fabrics, occasions — editable in the portal so Rakesh can
// add a colour without a deploy. Seeded from the Reference tab by the
// importer; consumed by minting, intake and the master editor.
export default async function LovsPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  const { data } = await admin.from("lovs").select("*").order("list").order("sort").order("code");
  return <LovsEditor rows={(data ?? []) as LovRow[]} />;
}

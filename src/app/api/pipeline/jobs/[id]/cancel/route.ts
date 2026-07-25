import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Cancel a job — only while still 'queued' (§8.3); anything later belongs to
// the runner, which always finalises its own row.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("pipeline_jobs")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("status", "queued")
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ error: "Job is no longer queued" }, { status: 409 });
  return NextResponse.json({ ok: true });
}

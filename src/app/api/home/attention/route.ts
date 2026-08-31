import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { computeAttention } from "@/lib/attention";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireStaff();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ items: await computeAttention() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

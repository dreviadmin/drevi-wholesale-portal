import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { renderOrderPdf } from "@/lib/order-pdf";
import type { Order } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// On-demand PDF (the "Download PDF" fallback). RLS scopes order access to the
// owning buyer or staff.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: order } = await supabase.from("orders").select("*").eq("id", params.id).maybeSingle();
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: buyer } = await admin
    .from("buyers")
    .select("business_name, owner_name, phone, city")
    .eq("id", (order as Order).buyer_id)
    .maybeSingle();

  const pdf = await renderOrderPdf(order as Order, buyer ?? { business_name: null, owner_name: null, phone: null, city: null });
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${(order as Order).order_number}.pdf"`,
    },
  });
}

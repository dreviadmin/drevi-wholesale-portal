import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { renderOrderPdf } from "@/lib/order-pdf";
import { resolveDocumentParty } from "@/lib/buyer-snapshot";
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
  const o = order as Order;

  // The party frozen onto the order when it was issued (select("*") carries the
  // snapshot columns), NOT whoever the buyers row names today — this route is
  // the permanent address of a document that must reprint identically forever.
  const admin = createAdminClient();
  const buyer = await resolveDocumentParty(admin, o, o.buyer_id);

  const pdf = await renderOrderPdf(o, buyer);
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${o.order_number}.pdf"`,
    },
  });
}

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { renderCreditNotePdf, type PdfBuyer } from "@/lib/order-pdf";
import { creditNoteFileName } from "@/lib/share";
import type { CreditNoteRow } from "@/lib/credit-load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// On-demand credit-note PDF (11 Sep), modelled on the retail-bill route. The
// stored pdf_url is a 30-day signed link — this route is the permanent address:
// it regenerates from the note's OWN snapshot every time, so it never expires
// and never drifts from the record (a voided note reprints as VOIDED).
// Staff only, like the retail route: the customer is handed the file itself.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try { await requireStaff(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const admin = createAdminClient();
  const { data: note } = await admin.from("credit_notes").select("*").eq("id", params.id).maybeSingle();
  if (!note) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const n = note as CreditNoteRow;

  // A note without a party (never a wholesale one — orders.buyer_id is not
  // null) still has to print; it just has no party block to fill.
  let buyer: PdfBuyer = { business_name: null, owner_name: null, phone: null, city: null };
  if (n.buyer_id) {
    const { data } = await admin
      .from("buyers")
      .select("business_name, owner_name, phone, city")
      .eq("id", n.buyer_id)
      .maybeSingle();
    if (data) buyer = data as PdfBuyer;
  }

  const pdf = await renderCreditNotePdf(n, buyer);
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${creditNoteFileName(n.note_number)}"`,
    },
  });
}

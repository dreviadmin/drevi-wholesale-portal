import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createServerSupabase } from "@/lib/supabase/server";
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
// Staff, OR the buyer the note belongs to (Ansh, 12 Sep — a wholesale buyer
// signed into the portal can open their own credit note from their wallet).
// Any other session gets 404, not 403: an outsider learns nothing about which
// note ids exist.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const admin = createAdminClient();
  const { data: note } = await admin.from("credit_notes").select("*").eq("id", params.id).maybeSingle();
  if (!note) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const n = note as CreditNoteRow;

  let allowed = true;
  try {
    await requireStaff();
  } catch {
    allowed = false;
    // Not staff — is this the buyer's own note?
    const { data: { user } } = await createServerSupabase().auth.getUser();
    if (user?.email && n.buyer_id) {
      const { data: rows } = await admin
        .from("buyers")
        .select("id")
        .eq("email", user.email)
        .not("encrypted_password", "is", null)
        .limit(1);
      if (rows?.[0]?.id === n.buyer_id) allowed = true;
    }
  }
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

import { notFound } from "next/navigation";
import { requireAdminOrRedirect, isAdminRole } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedCardUrl } from "@/lib/storage";
import { BuyerDetail } from "./BuyerDetail";
import type { Buyer, Order } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function BuyerDetailPage({ params }: { params: { id: string } }) {
  const staff = await requireAdminOrRedirect();
  const admin = createAdminClient();

  const { data: buyer } = await admin.from("buyers").select("*").eq("id", params.id).maybeSingle();
  if (!buyer) notFound();
  const b = buyer as Buyer;

  const [{ data: orders }, { data: audit }, { data: staffRows }] = await Promise.all([
    admin.from("orders").select("id, order_number, total_amount, status, submitted_at").eq("buyer_id", b.id).order("submitted_at", { ascending: false }),
    admin.from("auth_audit_log").select("event_type, event_at, staff_user_id, notes").eq("buyer_id", b.id).order("event_at", { ascending: false }).limit(25),
    admin.from("staff_users").select("id, name"),
  ]);

  const staffName = new Map<string, string>((staffRows ?? []).map((s) => [s.id, s.name ?? "Staff"]));
  const cardUrl = b.card_image_path ? await signedCardUrl(b.card_image_path) : null;

  return (
    <BuyerDetail
      isAdmin={isAdminRole(staff.role)}
      buyer={{
        id: b.id,
        email: b.email,
        business_name: b.business_name,
        owner_name: b.owner_name,
        phone: b.phone,
        city: b.city,
        gstin: b.gstin,
        address: b.address,
        transport_details: b.transport_details,
        broker_details: b.broker_details,
        other_details: b.other_details,
        status: b.status,
        source: b.source,
        notes: b.notes,
        created_at: b.created_at,
        approved_at: b.approved_at,
        approvedByName: b.approved_by ? staffName.get(b.approved_by) ?? null : null,
        hasPassword: !!b.encrypted_password,
        cardUrl,
      }}
      orders={((orders ?? []) as Pick<Order, "id" | "order_number" | "total_amount" | "status" | "submitted_at">[])}
      activity={(audit ?? []).map((a) => ({
        event_type: a.event_type,
        event_at: a.event_at,
        notes: a.notes,
        staffName: a.staff_user_id ? staffName.get(a.staff_user_id) ?? "Staff" : null,
      }))}
    />
  );
}

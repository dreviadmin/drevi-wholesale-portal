import { notFound } from "next/navigation";
import { requireStaffOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { ExhibitionWizard } from "./ExhibitionWizard";
import type { WholesaleProduct, Buyer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ExhibitionSessionPage({ params }: { params: { id: string } }) {
  const me = await requireStaffOrRedirect();
  const admin = createAdminClient();

  const { data: session } = await admin.from("exhibition_sessions").select("id, event_name, ended_at, session_type").eq("id", params.id).maybeSingle();
  if (!session) notFound();

  // Products and buyers are paged with fetchAll: a bare select stops at 1,000
  // rows without a word, so the booth could not find a garment or a party past
  // that point. Each sort ends in the primary key so no row falls between pages.
  const [products, buyers, { data: staffRows }] = await Promise.all([
    fetchAll<WholesaleProduct>(admin, "wholesale_products", "*", (q) =>
      q.eq("wholesale_visible", true).order("category", { nullsFirst: false }).order("title", { nullsFirst: false }).order("sku"),
    ),
    // Active + pending are both orderable at the booth (only suspended/rejected
    // are excluded) — pending rows predate the capture-goes-active change.
    fetchAll<Pick<Buyer, "id" | "business_name" | "owner_name" | "phone" | "city" | "status">>(
      admin, "buyers", "id, business_name, owner_name, phone, city, status",
      (q) => q.in("status", ["active", "pending"]).order("business_name", { nullsFirst: false }).order("id"),
    ),
    // "Taken by" selector (UX sprint) — who is physically taking this order.
    admin.from("staff_users").select("id, name, email").eq("active", true).order("name"),
  ]);

  return (
    <ExhibitionWizard
      session={{ id: session.id, event_name: session.event_name, ended: !!session.ended_at, type: session.session_type === "in_store" ? "in_store" : "exhibition" }}
      products={products}
      buyers={buyers}
      stockAsOf={new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}
      staffList={(staffRows ?? []).map((r) => ({ id: r.id, name: r.name ?? r.email }))}
      meId={me.id}
    />
  );
}

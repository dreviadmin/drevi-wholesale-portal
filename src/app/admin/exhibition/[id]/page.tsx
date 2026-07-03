import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { ExhibitionWizard } from "./ExhibitionWizard";
import type { WholesaleProduct, Buyer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ExhibitionSessionPage({ params }: { params: { id: string } }) {
  await requireStaff();
  const admin = createAdminClient();

  const { data: session } = await admin.from("exhibition_sessions").select("id, event_name, ended_at, session_type").eq("id", params.id).maybeSingle();
  if (!session) notFound();

  const [{ data: products }, { data: buyers }] = await Promise.all([
    admin.from("wholesale_products").select("*").eq("wholesale_visible", true).order("category", { nullsFirst: false }).order("title", { nullsFirst: false }),
    // Active + pending are both orderable at the booth (only suspended/rejected
    // are excluded) — pending rows predate the capture-goes-active change.
    admin.from("buyers").select("id, business_name, owner_name, phone, city, status").in("status", ["active", "pending"]).order("business_name", { nullsFirst: false }),
  ]);

  return (
    <ExhibitionWizard
      session={{ id: session.id, event_name: session.event_name, ended: !!session.ended_at, type: session.session_type === "in_store" ? "in_store" : "exhibition" }}
      products={(products ?? []) as WholesaleProduct[]}
      buyers={(buyers ?? []) as Pick<Buyer, "id" | "business_name" | "owner_name" | "phone" | "city" | "status">[]}
      stockAsOf={new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
    />
  );
}

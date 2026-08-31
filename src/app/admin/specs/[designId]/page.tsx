import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { SpecsEditor } from "./SpecsEditor";

export const dynamic = "force-dynamic";

// Retrofit R4 §6.2 — specs-only view, safe for the shared counter device.
// The full master editor exposes cost, so it cannot live in floor scope; this
// screen carries ident photo, SKU, descriptive fields, the supplier block and
// the specs_verified toggle — and NO pricing, cost or vendor cost data.
//
// (Device/floor scope itself isn't built in this repo — see ANSH-20. Access is
// gated by the admin role that exists.)
export default async function SpecsPage({ params }: { params: { designId: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const { data: design } = await admin
    .from("designs")
    .select("id, base_sku, color, title, category, sub_category, fabric, handwork, origin, specs_verified, ident_image_id, supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_note, supply_updated_at, supply_updated_by")
    .eq("id", params.designId)
    .maybeSingle();
  if (!design) notFound();

  let identRef: string | null = null;
  if (design.ident_image_id) {
    const { data: img } = await admin.from("design_images").select("file_ref").eq("id", design.ident_image_id).maybeSingle();
    identRef = img?.file_ref ?? null;
  }

  return (
    <SpecsEditor
      design={{
        id: design.id,
        baseSku: design.base_sku,
        color: design.color,
        title: design.title,
        category: design.category,
        subCategory: design.sub_category,
        fabric: design.fabric ?? "",
        handwork: design.handwork ?? "",
        origin: design.origin ?? "",
        specsVerified: design.specs_verified,
        identRef,
        supply: {
          supplyMode: (design.supply_mode ?? "") as "" | "ready_stock" | "made_to_order" | "both" | "discontinued",
          vendorStockQty: design.vendor_stock_qty,
          makingDays: design.making_days,
          makingMoq: design.making_moq,
          deliveryDays: design.delivery_days,
          supplyNote: design.supply_note ?? "",
        },
        supplyUpdatedAt: design.supply_updated_at,
        supplyUpdatedBy: design.supply_updated_by,
      }}
    />
  );
}

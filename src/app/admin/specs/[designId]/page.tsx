import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadVocab } from "@/lib/sku/vocab-live";
import { colorNameFor, describeDesignFacts } from "@/lib/studio/facts";
import { SpecsEditor } from "./SpecsEditor";

export const dynamic = "force-dynamic";

// Retrofit R4 §6.2 — specs view for the shared counter device. It carries the
// ident photo, SKU, descriptive fields, the supplier block, the specs_verified
// toggle and (11 Sep, docs/DECISIONS.md) the buyer-visible WHOLESALE price for
// every size of the design. It still carries NO cost, MRP or vendor cost data —
// those live in the Product Master. Variants are loaded with sku + price only.
//
// (Device/floor scope itself isn't built in this repo — see ANSH-20. Access is
// gated by the admin role that exists.)
export default async function SpecsPage({ params }: { params: { designId: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const { data: design } = await admin
    .from("designs")
    .select("id, base_sku, color, title, category, sub_category, fabric, handwork, origin, color_name, specs_verified, ident_image_id, supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_note, supply_updated_at, supply_updated_by, updated_at")
    .eq("id", params.designId)
    .maybeSingle();
  if (!design) notFound();

  let identRef: string | null = null;
  if (design.ident_image_id) {
    const { data: img } = await admin.from("design_images").select("file_ref").eq("id", design.ident_image_id).maybeSingle();
    identRef = img?.file_ref ?? null;
  }

  const [{ data: allVariants }, vocab] = await Promise.all([
    admin.from("wholesale_products").select("sku, wholesale_price").like("sku", `${design.base_sku}-%`).order("sku"),
    loadVocab(),
  ]);
  // `like` also matches sibling colours of the same base — the suffix filter is load-bearing.
  const variants = (allVariants ?? [])
    .filter((v) => v.sku.toUpperCase().endsWith(`-${design.color.toUpperCase()}`))
    .map((v) => ({ sku: v.sku, wholesalePrice: Number(v.wholesale_price) || 0 }));
  const facts = describeDesignFacts({ category: design.category, subCategory: design.sub_category, color: design.color }, vocab);

  return (
    <SpecsEditor
      design={{
        id: design.id,
        baseSku: design.base_sku,
        color: design.color,
        title: design.title,
        category: design.category,
        subCategory: design.sub_category,
        categoryLabel: facts.categoryName,
        subCategoryLabel: facts.subCategoryName,
        categoryCode: facts.categoryCode,
        subCategoryCode: facts.subCategoryCode,
        colorVocabName: colorNameFor(design.color, vocab),
        fabric: design.fabric ?? "",
        handwork: design.handwork ?? "",
        origin: design.origin ?? "",
        colorName: design.color_name ?? "",
        specsVerified: design.specs_verified,
        identRef,
        variants,
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
        updatedAt: design.updated_at ?? null,
      }}
    />
  );
}

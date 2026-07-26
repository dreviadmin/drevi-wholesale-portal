import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadDesignDetail } from "@/lib/studio/load";
import { MasterEditor } from "./MasterEditor";

export const dynamic = "force-dynamic";

// Product Master editor (build guide §12.1) — the design-level record:
// specs (with Rakesh's confirmation), pricing (auto-MRP with override),
// publish toggles, and per-size stock/wholesale rows. Photo/visibility/
// rename tools stay in Manage Catalog until the ANSH-07 cutover retires it.
export default async function MasterPage({ params }: { params: { designId: string } }) {
  await requireAdminOrRedirect();
  const detail = await loadDesignDetail(params.designId);
  if (!detail) notFound();
  const admin = createAdminClient();

  const { data: design } = await admin
    .from("designs")
    .select("fabric, handwork, origin, specs_verified, tier, markup_multiplier, auto_mrp, mrp_override")
    .eq("id", params.designId)
    .single();
  const { data: allVariants } = await admin
    .from("wholesale_products")
    .select("sku, current_qty, wholesale_price, wholesale_visible")
    .like("sku", `${detail.board.baseSku}-%`)
    .order("sku");
  const variants = (allVariants ?? []).filter((v) => v.sku.toUpperCase().endsWith(`-${detail.board.color}`));
  const skus = variants.map((v) => v.sku);
  const { data: pvi } = skus.length
    ? await admin.from("product_vendor_info").select("sku, last_cost, retail_price").in("sku", skus)
    : { data: [] };
  const lastCost = Math.max(0, ...(pvi ?? []).map((p) => Number(p.last_cost) || 0));
  const sheetMrp = Math.max(0, ...(pvi ?? []).map((p) => Number(p.retail_price) || 0));

  return (
    <MasterEditor
      board={detail.board}
      design={{
        fabric: design?.fabric ?? "",
        handwork: design?.handwork ?? "",
        origin: design?.origin ?? "",
        specsVerified: design?.specs_verified ?? false,
        tier: design?.tier ?? "standard",
        markupMultiplier: Number(design?.markup_multiplier ?? 2.5),
        autoMrp: design?.auto_mrp != null ? Number(design.auto_mrp) : null,
        mrpOverride: design?.mrp_override != null ? Number(design.mrp_override) : null,
      }}
      variants={variants}
      lastCost={lastCost}
      sheetMrp={sheetMrp}
    />
  );
}

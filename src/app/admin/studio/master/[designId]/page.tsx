import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadDesignDetail } from "@/lib/studio/load";
import { NotesPanel } from "@/components/admin/NotesPanel";
import { listEntityNotes } from "@/lib/entity-notes";
import { MasterEditor } from "./MasterEditor";
import { listKnownHsnCodes } from "@/lib/hsn";

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
    .select("fabric, handwork, origin, specs_verified, tier, markup_multiplier, auto_mrp, mrp_override, supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_note, supply_updated_at, vendor_sku, ident_image_id")
    .eq("id", params.designId)
    .single();
  const { data: allVariants } = await admin
    .from("wholesale_products")
    .select("sku, current_qty, wholesale_price, wholesale_visible, hsn, location")
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
    <>
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
        vendorSku: design?.vendor_sku ?? null,
        supply: {
          supplyMode: (design?.supply_mode ?? "") as "" | "ready_stock" | "made_to_order" | "both" | "discontinued",
          vendorStockQty: design?.vendor_stock_qty ?? null,
          makingDays: design?.making_days ?? null,
          makingMoq: design?.making_moq ?? null,
          deliveryDays: design?.delivery_days ?? null,
          supplyNote: design?.supply_note ?? "",
        },
        supplyUpdatedAt: design?.supply_updated_at ?? null,
      }}
      variants={variants}
      hsn={variants.find((v) => v.hsn)?.hsn ?? ""}
      hsnOptions={await listKnownHsnCodes()}
      lastCost={lastCost}
      sheetMrp={sheetMrp}
    />
    <div className="px-4 md:px-8 pb-10 max-w-2xl">
      <NotesPanel entityType="design" entityId={params.designId} notes={await listEntityNotes("design", params.designId)} revalidate={`/admin/studio/master/${params.designId}`} />
    </div>
    </>
  );
}

import Link from "next/link";
import { BackLink } from "@/components/BackLink";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { receiptIntakeV2, supplyStaleDays } from "@/lib/env";
import { warnIfUnconfigured } from "@/lib/drive-design";
import { listKnownHsnCodes } from "@/lib/hsn";
import { loadVocab } from "@/lib/sku/vocab-live";
import { captureEnabled, captureDestinationNote } from "@/lib/design-image-store";
import { ReceiptEditor } from "../ReceiptEditor";
import { DeliveryIntake } from "./DeliveryIntake";

export const dynamic = "force-dynamic";

// saveDelivery (a server action run from this page) writes a header and then
// loops ~10 Supabase round trips per size with no transaction around it. A
// big delivery cut off by the 60s default leaves a half-saved receipt, so the
// same 300s stock-take has. The replay check in saveDelivery is the other belt.
export const maxDuration = 300;

// Retrofit R3 — "Log delivery" behind RECEIPT_INTAKE_V2. The previous receipt
// form stays reachable and unchanged until the flag flips (§0.4, §5.1).
export default async function NewReceiptPage({ searchParams }: { searchParams: { sku?: string; design?: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  warnIfUnconfigured();

  const [{ data: vendors }, skus] = await Promise.all([
    admin.from("vendors").select("id, name, city").eq("active", true).order("name"),
    fetchAll<{ variant_sku: string }>(admin, "sku_registry", "variant_sku"),
  ]);
  const vendorList = (vendors ?? []).map((v) => ({ id: v.id, name: v.name, city: v.city }));

  if (!receiptIntakeV2()) {
    return (
      <div className="px-4 md:px-6 py-5 max-w-2xl">
        <BackLink fallback="/admin/receipts" fallbackLabel="Receipts" />
        <h1 className="font-display mt-3" style={{ fontSize: 22, fontWeight: 600, color: "#1A1A1A" }}>New Goods Receipt</h1>
        <ReceiptEditor
          vendors={vendorList}
          registrySkus={skus.map((s) => s.variant_sku)}
          prefillSku={searchParams.sku?.trim() || undefined}
        />
      </div>
    );
  }

  // Known designs for the reorder path (§5.5): ident thumb, supply, last cost.
  // Paged with fetchAll: a bare select stops at 1,000 rows without a word, so
  // designs past that point could not be found to reorder. Each sort ends in
  // the primary key so no row can fall between two pages.
  type KnownDesignRow = {
    id: string; base_sku: string; color: string; title: string | null; vendor_sku: string | null; ident_image_id: string | null;
    supply_mode: string | null; vendor_stock_qty: number | null; making_days: number | null; making_moq: number | null;
    delivery_days: number | null; supply_note: string | null; supply_updated_at: string | null;
  };
  const [designs, identImages, costs] = await Promise.all([
    fetchAll<KnownDesignRow>(
      admin, "designs",
      "id, base_sku, color, title, vendor_sku, ident_image_id, supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_note, supply_updated_at",
      (q) => q.order("base_sku").order("id"),
    ),
    fetchAll<{ id: string; file_ref: string }>(admin, "design_images", "id, file_ref", (q) => q.eq("role", "ident").order("id")),
    fetchAll<{ sku: string; last_cost: number }>(admin, "product_vendor_info", "sku, last_cost", (q) => q.gt("last_cost", 0).order("sku")),
  ]);
  const identBy = new Map(identImages.map((i) => [i.id, i.file_ref]));
  const costByGroup = new Map<string, number>();
  for (const c of costs) {
    const parts = c.sku.toUpperCase().split("-");
    if (parts.length < 5 || !/^\d{2,4}$/.test(parts[3])) continue;
    const key = `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`;
    costByGroup.set(key, Math.max(costByGroup.get(key) ?? 0, Number(c.last_cost)));
  }

  const knownDesigns = designs.map((d) => ({
    id: d.id,
    baseSku: d.base_sku,
    color: d.color,
    title: d.title,
    identRef: d.ident_image_id ? identBy.get(d.ident_image_id) ?? null : null,
    vendorSku: d.vendor_sku,
    lastCost: costByGroup.get(`${d.base_sku}|${d.color}`) ?? null,
    supplyUpdatedAt: d.supply_updated_at,
    supply: {
      supplyMode: (d.supply_mode ?? "") as "" | "ready_stock" | "made_to_order" | "both" | "discontinued",
      vendorStockQty: d.vendor_stock_qty,
      makingDays: d.making_days,
      makingMoq: d.making_moq,
      deliveryDays: d.delivery_days,
      supplyNote: d.supply_note ?? "",
    },
  }));

  return (
    <div className="px-4 md:px-6 py-5 max-w-2xl">
      <BackLink fallback="/admin/receipts" fallbackLabel="Receipts" />
      <div className="mt-3 flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: "#1A1A1A" }}>Log delivery</h1>
        <Link href="/admin/receipts" className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.16em", color: "#8a6d1a" }}>
          Receipt history →
        </Link>
      </div>
      <p className="font-body mt-1" style={{ fontSize: 11.5, color: "#998F7A" }}>
        One garment at a time — mint, photograph, count, price and capture supply in a single motion.
      </p>
      <div className="mt-4">
        <DeliveryIntake
          vendors={vendorList}
          knownDesigns={knownDesigns}
          uploadsOk={captureEnabled()}
          uploadsMessage={captureDestinationNote()}
          hsnOptions={await listKnownHsnCodes()}
          vocab={await loadVocab()}
          staleDays={supplyStaleDays()}
          prefillDesignId={searchParams.design?.trim() || undefined}
        />
      </div>
    </div>
  );
}

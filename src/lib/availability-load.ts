import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { handlingDays, availabilityBufferDays, limitedThreshold } from "@/lib/env";
import { computeAvailability, toBuyerAvailability, type Availability, type SupplyInput } from "@/lib/availability";

// Retrofit R7 (§9) — the one place buyer surfaces get availability from.
//
// It reads the design's supply block server-side, runs the single
// implementation, and returns ONLY the buyer-safe object. The raw supply row
// never leaves this module, so no buyer surface can accidentally serialise the
// vendor's stock, the making MOQ or the individual lead-time components (§9.2).

export interface SkuAvailability {
  sku: string;
  availability: Availability;
  /** §9.4 — how old the supply data is. Admin surfaces only; buyers never see it. */
  supplyUpdatedAt: string | null;
}

const EMPTY_SUPPLY: SupplyInput = {
  supplyMode: "", vendorStockQty: null, makingDays: null, deliveryDays: null,
  makingMoq: null, supplyUpdatedAt: null,
};

/** DD-SUT-PLZ-034-M-GRN → { base: "DD-SUT-PLZ-034", color: "GRN" } */
function splitSku(sku: string): { base: string; color: string } | null {
  const parts = sku.split("-");
  if (parts.length < 6) return null;
  return { base: parts.slice(0, 4).join("-"), color: parts[parts.length - 1] };
}

/**
 * Availability for a set of SKUs. `stockBySku` comes from whatever the caller
 * already loaded (wholesale_products.current_qty), so this makes exactly one
 * extra query regardless of how many SKUs are asked for.
 */
export async function availabilityForSkus(
  stockBySku: Map<string, { currentQty: number; buyerMoq?: number }>,
): Promise<Map<string, SkuAvailability>> {
  const out = new Map<string, SkuAvailability>();
  const skus = [...stockBySku.keys()];
  if (skus.length === 0) return out;

  const wanted = new Map<string, { base: string; color: string }>();
  for (const sku of skus) {
    const p = splitSku(sku);
    if (p) wanted.set(sku, p);
  }

  const admin = createAdminClient();
  const bases = [...new Set([...wanted.values()].map((p) => p.base))];
  const { data: designs } = bases.length
    ? await admin
        .from("designs")
        .select("base_sku, color, supply_mode, vendor_stock_qty, making_days, making_moq, delivery_days, supply_updated_at")
        .in("base_sku", bases)
    : { data: [] };

  const supplyByKey = new Map<string, SupplyInput>();
  for (const d of designs ?? []) {
    supplyByKey.set(`${d.base_sku}|${String(d.color).toUpperCase()}`, {
      supplyMode: d.supply_mode ?? "",
      vendorStockQty: d.vendor_stock_qty ?? null,
      makingDays: d.making_days ?? null,
      deliveryDays: d.delivery_days ?? null,
      makingMoq: d.making_moq ?? null,
      supplyUpdatedAt: d.supply_updated_at ?? null,
    });
  }

  const handling = handlingDays();
  const buffer = availabilityBufferDays();
  const limited = limitedThreshold();

  for (const sku of skus) {
    const stock = stockBySku.get(sku)!;
    const parts = wanted.get(sku);
    const supply = parts ? supplyByKey.get(`${parts.base}|${parts.color.toUpperCase()}`) ?? EMPTY_SUPPLY : EMPTY_SUPPLY;
    const availability = toBuyerAvailability(
      computeAvailability({
        ourStock: stock.currentQty,
        supply,
        buyerMoq: stock.buyerMoq ?? 1,
        handlingDays: handling,
        bufferDays: buffer,
        limitedThreshold: limited,
      }),
    );
    out.set(sku, { sku, availability, supplyUpdatedAt: supply.supplyUpdatedAt });
  }
  return out;
}

/** Single-SKU convenience for the product page. */
export async function availabilityForSku(sku: string, currentQty: number, buyerMoq = 1): Promise<SkuAvailability> {
  const m = await availabilityForSkus(new Map([[sku, { currentQty, buyerMoq }]]));
  return (
    m.get(sku) ?? {
      sku,
      availability: toBuyerAvailability(
        computeAvailability({
          ourStock: currentQty, supply: EMPTY_SUPPLY, buyerMoq,
          handlingDays: handlingDays(), bufferDays: availabilityBufferDays(), limitedThreshold: limitedThreshold(),
        }),
      ),
      supplyUpdatedAt: null,
    }
  );
}

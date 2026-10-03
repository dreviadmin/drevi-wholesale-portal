// What a price tag prints for one SKU — pure, so vitest can pin it.
//
// Ansh, 28 Sep: tags printed from Studio came out with no price, no vendor.
// The tag route read ONLY the sheet-era columns of product_vendor_info
// (vendor_name, vendor_sku, retail_price). A garment received through Log
// delivery records its vendor as vendor_id (a uuid into vendors), never
// vendor_name; its MRP lives on the design (mrp_override ?? auto_mrp, the
// price Shopify sells at); and a size that is minted but not yet in the
// catalog has no rows at all. So on prod 92 of 290 Studio-printable SKUs
// printed "--" for the vendor and 124 printed "Rs -".
//
// Rule: every field keeps its current source first — nothing that prints
// today changes — and a blank falls back to the portal's own record. The one
// exception is the MRP (3 Oct): the Specs MRP now wins over the sheet's, by
// the shared rule in retail-price-core.ts, so the tag, the counter bill and
// the price check can never quote different prices.

import { effectiveRetailPrice } from "./retail-price-core";
export { designKeyOf } from "./retail-price-core";

export interface VendorInfoRow {
  vendor_name?: string | null;
  vendor_id?: string | null;
  vendor_sku?: string | null;
  last_cost?: number | string | null;
  retail_price?: number | string | null;
}

export interface DesignPriceRow {
  vendor_id?: string | null;
  vendor_sku?: string | null;
  mrp_override?: number | string | null;
  auto_mrp?: number | string | null;
  wholesale_override?: number | string | null;
  auto_wholesale?: number | string | null;
}

export interface LabelDatum {
  sku: string;
  found: boolean;
  vendorCode: string;
  mrp: string;
}

const positive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** kf: 1250 → '01.2', 12500 → '12.5', missing → '--.-'. Truncates to one
 *  decimal (the spec's 1250 example demands it), never rounds. */
export function kf(v: unknown): string {
  const n = positive(v);
  if (n == null) return "--.-";
  const k = (Math.floor(n / 100) / 10).toFixed(1);
  return n / 1000 < 10 ? k.padStart(4, "0") : k;
}

/** First two letters of the vendor's name, uppercase; "--" when there are not two. */
export function v2(vendorName: unknown): string {
  const letters = String(vendorName ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return letters.length >= 2 ? letters.slice(0, 2) : "--";
}

export function resolveLabelDatum(input: {
  sku: string;
  vendorInfo: VendorInfoRow | null | undefined;
  wholesalePrice: number | string | null | undefined;
  /** Whether wholesale_products has a row for this SKU at all. */
  inCatalog: boolean;
  design: DesignPriceRow | null | undefined;
  vendorNameById: ReadonlyMap<string, string>;
}): LabelDatum {
  const { sku, vendorInfo: v, design: d, vendorNameById } = input;
  const found = !!(v || input.inCatalog || d);
  if (!found) return { sku, found: false, vendorCode: "---------", mrp: "" };

  const vendorName =
    v?.vendor_name?.trim() ||
    (v?.vendor_id ? vendorNameById.get(v.vendor_id) : undefined) ||
    (d?.vendor_id ? vendorNameById.get(d.vendor_id) : undefined) ||
    null;
  const vendorSku = v?.vendor_sku?.trim() || d?.vendor_sku?.trim() || "-";
  const cost = positive(v?.last_cost);
  const wholesale = positive(input.wholesalePrice) ?? positive(d?.wholesale_override ?? d?.auto_wholesale);
  // Specs MRP first, the sheet's Final MRP only as the fallback — the same
  // rule the counter bill and the price check use (retail-price-core.ts).
  const mrpNum = effectiveRetailPrice(d, v?.retail_price);

  return {
    sku,
    found: true,
    vendorCode: `${v2(vendorName)}-${vendorSku}-${kf(cost)}-${kf(wholesale)}`,
    mrp: mrpNum != null ? Math.round(mrpNum).toLocaleString("en-IN") : "",
  };
}


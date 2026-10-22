// The retail price (MRP) a SKU sells at — one rule for the price tag, the
// counter's retail bill, the retail price check and the scan sheet.
//
// Ansh, 3 Oct: "Some designs (like DD-LEH-FLR-101-L-RST) still pick older
// prices while printing tag (probably from the sheet), instead of the new one
// in the specs section of the portal." The Specs MRP (designs.mrp_override,
// else the saved auto-MRP — the price Shopify sells at) now wins. The sheet's
// Final MRP (product_vendor_info.retail_price, still rewritten by the sheet
// sync) is only the fallback for a SKU whose design has no MRP — or has no
// design at all (old sheet-only SKUs, custom catalog lines). On the day this
// changed, 158 prod sizes had a sheet price that disagreed with Specs.

export interface DesignMrpRow {
  mrp_override?: number | string | null;
  auto_mrp?: number | string | null;
  /** Retail compare-at ("was") price (0076). */
  compare_at_price?: number | string | null;
}

const positive = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The Specs ("Effective") MRP as saved: the override, else the auto-MRP. */
export function specsMrp(design: DesignMrpRow | null | undefined): number | null {
  return positive(design?.mrp_override) ?? positive(design?.auto_mrp);
}

/** Specs MRP first, the sheet's Final MRP as the fallback; null = no price anywhere. */
export function effectiveRetailPrice(design: DesignMrpRow | null | undefined, sheetRetail: unknown): number | null {
  return specsMrp(design) ?? positive(sheetRetail);
}

/** (base, colour) key of a variant SKU — DD-CAT-SUB-NNN-<size…>-COLOR. */
export function designKeyOf(sku: string): string | null {
  const parts = sku.trim().toUpperCase().split("-");
  if (parts.length < 5) return null;
  return `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`;
}

// The retail compare-at ("was") price (Ansh, 22 Oct 2026): printed struck
// through above the MRP on the tag and sent to Shopify as compareAtPrice. It
// only counts while it is ABOVE the price it is compared with, so an MRP
// raised past it later stops showing it instead of printing a "was" price
// lower than the price.

/** The compare-at price to show beside `price`, or null when there is none to show. */
export function effectiveCompareAt(design: DesignMrpRow | null | undefined, price: number | null | undefined): number | null {
  const cmp = positive(design?.compare_at_price);
  const p = positive(price);
  if (cmp == null || p == null) return null;
  return Math.round(cmp) > Math.round(p) ? cmp : null;
}

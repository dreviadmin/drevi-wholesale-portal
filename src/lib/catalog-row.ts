import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { designKeyOf } from "@/lib/retail-price-core";

// A minted garment is billable the moment it exists (Ansh, 7 Oct: "an item
// shall be available for billing/bill updation as soon as it is available").
// DD-SAR-PRD-099-L-BGE was minted in Log delivery, showed on the Studio board,
// and still could not be added to an in-store order, because the catalog row
// that billing reads was only created when the DELIVERY was saved. Staff
// billed it as a CUSTOM line instead. Minting now creates the row; Modify
// Order also creates it on demand for a SKU minted before this rule.
//
// The row is created exactly as saveDelivery creates it (30 Sep rule):
// sellable at the counter (wholesale_visible), hidden from buyers (buyer
// catalog only opens through a Studio push), stock 0 (the ledger moves it when
// the delivery is counted in), restockable so a zero-stock garment is "made to
// order", not "sold out".

/**
 * The wholesale price every priced size of a (base, colour) group agrees on,
 * else 0. Mixed per-size prices leave a new size at 0 (unlocked) so the Specs
 * page's mixed-price hint asks a human instead of locking a guess.
 */
export async function pricedSiblingPrice(admin: SupabaseClient, baseSku: string, color: string): Promise<number> {
  const prefix = `${baseSku}-`.toUpperCase();
  const suffix = `-${color}`.toUpperCase();
  const { data } = await admin.from("wholesale_products").select("sku, wholesale_price").ilike("sku", `${prefix}%${suffix}`).gt("wholesale_price", 0);
  const seen = new Set<number>();
  for (const p of data ?? []) {
    const sku = String(p.sku).toUpperCase();
    const size = sku.slice(prefix.length, sku.length - suffix.length);
    if (sku.startsWith(prefix) && sku.endsWith(suffix) && size && !size.includes("-")) seen.add(Number(p.wholesale_price) || 0);
  }
  return seen.size === 1 ? [...seen][0] : 0;
}

export type CatalogRowResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "not_minted" | "no_design" | "error"; error?: string };

/**
 * Make sure a minted SKU has its catalog row. Refuses a SKU that was never
 * minted, or whose (base, colour) has no design: those are typos or the
 * SKU generator's historical registry rows, not garments in the shop.
 */
export async function ensureCatalogRow(
  admin: SupabaseClient,
  rawSku: string,
  opts?: { title?: string | null; hsn?: string | null },
): Promise<CatalogRowResult> {
  const sku = (rawSku ?? "").trim().toUpperCase();
  const key = designKeyOf(sku);
  if (!key) return { ok: false, reason: "not_minted" };

  const { data: existing } = await admin.from("wholesale_products").select("sku").eq("sku", sku).maybeSingle();
  if (existing) return { ok: true, created: false };

  const { data: reg } = await admin.from("sku_registry").select("variant_sku").ilike("variant_sku", sku).maybeSingle();
  if (!reg) return { ok: false, reason: "not_minted" };

  const [base, color] = key.split("|");
  const { data: design } = await admin.from("designs").select("color, title").ilike("base_sku", base).ilike("color", color).maybeSingle();
  if (!design) return { ok: false, reason: "no_design" };

  const price = await pricedSiblingPrice(admin, base, color);
  const hsn = opts?.hsn?.trim() && /^[0-9]{2,8}$/.test(opts.hsn.trim()) ? opts.hsn.trim() : null;
  const { error } = await admin.from("wholesale_products").insert({
    sku: reg.variant_sku,
    hsn,
    title: opts?.title?.trim() || design.title?.trim() || null,
    category: null,
    sub_category: null,
    color: design.color,
    wholesale_price: price,
    wholesale_visible: true,
    current_qty: 0,
    restockable: true,
    // The sheet sync must not flip visibility, nor overwrite an inherited price.
    locked_fields: price > 0 ? ["wholesale_visible", "wholesale_price"] : ["wholesale_visible"],
    synced_at: new Date().toISOString(),
  });
  // A concurrent mint or save created it first: that is success too.
  if (error && error.code !== "23505") return { ok: false, reason: "error", error: error.message };
  return { ok: true, created: !error };
}

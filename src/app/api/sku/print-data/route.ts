import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { designKeyOf, resolveLabelDatum, type DesignPriceRow, type VendorInfoRow } from "@/lib/label-data";

export const dynamic = "force-dynamic";

// Label print data. Staff can print labels, so this endpoint returns ONLY the
// derived, deliberately-obfuscated strings — never raw cost or wholesale
// numbers. The rule for each field lives in src/lib/label-data.ts: the
// sheet-era column first (so nothing that printed before changes), then the
// portal's own record — vendor by vendor_id, the design's MRP, vendor SKU and
// wholesale price — for garments that came in through Log delivery or Studio.

export async function POST(request: Request) {
  try {
    await requireStaff();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  let body: { skus?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const skus = Array.from(new Set((body.skus ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean)));
  if (skus.length === 0) return NextResponse.json({ items: [] });
  if (skus.length > 500) return NextResponse.json({ error: "Too many SKUs (max 500)" }, { status: 400 });

  const admin = createAdminClient();
  const bases = [...new Set(skus.map((s) => designKeyOf(s)?.split("|")[0]).filter((b): b is string => !!b))];
  const [vendRes, prodRes, designRes] = await Promise.all([
    admin.from("product_vendor_info").select("sku, vendor_name, vendor_id, vendor_sku, last_cost, retail_price").in("sku", skus),
    admin.from("wholesale_products").select("sku, wholesale_price").in("sku", skus),
    bases.length
      ? admin.from("designs").select("base_sku, color, vendor_id, vendor_sku, mrp_override, auto_mrp, wholesale_override, auto_wholesale").in("base_sku", bases)
      : Promise.resolve({ data: [], error: null }),
  ]);
  // A failed read must not print a roll of dashes that looks like real tags.
  const failed = [vendRes, prodRes, designRes].find((r) => r.error);
  if (failed?.error) return NextResponse.json({ error: `Could not read label data: ${failed.error.message}` }, { status: 500 });

  const vendBySku = new Map((vendRes.data ?? []).map((r) => [r.sku.toUpperCase(), r as VendorInfoRow]));
  const prodBySku = new Map((prodRes.data ?? []).map((r) => [r.sku.toUpperCase(), r]));
  const designByKey = new Map(
    ((designRes.data ?? []) as (DesignPriceRow & { base_sku: string; color: string })[]).map((d) => [`${d.base_sku.toUpperCase()}|${d.color.toUpperCase()}`, d]),
  );

  // Vendor names for every uuid either source points at, in one read.
  const vendorIds = new Set<string>();
  for (const v of vendBySku.values()) if (v.vendor_id) vendorIds.add(v.vendor_id);
  for (const d of designByKey.values()) if (d.vendor_id) vendorIds.add(d.vendor_id);
  // vendor_id on product_vendor_info is text: the sheet wrote its own codes
  // there, the portal writes uuids. Only uuids can name a vendors row.
  const uuids = [...vendorIds].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const vendorNameById = new Map<string, string>();
  if (uuids.length) {
    const { data: vrows, error: vErr } = await admin.from("vendors").select("id, name").in("id", uuids);
    if (vErr) return NextResponse.json({ error: `Could not read vendors: ${vErr.message}` }, { status: 500 });
    for (const r of vrows ?? []) vendorNameById.set(r.id, r.name);
  }

  const items = skus.map((sku) => {
    const key = designKeyOf(sku);
    const p = prodBySku.get(sku);
    return resolveLabelDatum({
      sku,
      vendorInfo: vendBySku.get(sku),
      wholesalePrice: p?.wholesale_price,
      inCatalog: !!p,
      design: key ? designByKey.get(key) : null,
      vendorNameById,
    });
  });

  return NextResponse.json({ items });
}

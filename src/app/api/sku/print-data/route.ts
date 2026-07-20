import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Label print data. Staff can print labels, so this endpoint returns ONLY the
// derived, deliberately-obfuscated strings — never raw cost or wholesale
// numbers. Phase 1 reads only the sheet-synced tables (behavioural parity
// with the reference tool); receipts become the cost source at Phase 3.

// kf: 1250 -> '01.2', 12500 -> '12.5', missing/NaN -> '--.-'
// The spec's 1250 example demands truncation to one decimal, not rounding.
function kf(v: unknown): string {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || String(v ?? "").trim() === "") return "--.-";
  const k = (Math.floor(n / 100) / 10).toFixed(1);
  return n / 1000 < 10 ? k.padStart(4, "0") : k;
}

function v2(vendorName: unknown): string {
  const letters = String(vendorName ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return letters.length >= 2 ? letters.slice(0, 2) : "--";
}

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
  const [{ data: vend }, { data: prods }] = await Promise.all([
    admin.from("product_vendor_info").select("sku, vendor_name, vendor_sku, last_cost, retail_price").in("sku", skus),
    admin.from("wholesale_products").select("sku, wholesale_price").in("sku", skus),
  ]);
  const vendBySku = new Map((vend ?? []).map((r) => [r.sku.toUpperCase(), r]));
  const prodBySku = new Map((prods ?? []).map((r) => [r.sku.toUpperCase(), r]));

  const items = skus.map((sku) => {
    const v = vendBySku.get(sku);
    const p = prodBySku.get(sku);
    const found = !!(v || p);
    if (!found) return { sku, found: false, vendorCode: "---------", mrp: "" };
    const cost = v?.last_cost != null && Number(v.last_cost) > 0 ? Number(v.last_cost) : "";
    const wholesale = p?.wholesale_price != null && Number(p.wholesale_price) > 0 ? Number(p.wholesale_price) : "";
    const vendorCode = `${v2(v?.vendor_name)}-${v?.vendor_sku?.trim() || "-"}-${kf(cost)}-${kf(wholesale)}`;
    const mrpNum = v?.retail_price != null && Number(v.retail_price) > 0 ? Math.round(Number(v.retail_price)) : null;
    const mrp = mrpNum != null ? mrpNum.toLocaleString("en-IN") : "";
    return { sku, found: true, vendorCode, mrp };
  });

  return NextResponse.json({ items });
}

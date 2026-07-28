import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { getDetailedCart } from "@/lib/cart";
import { availabilityForSkus } from "@/lib/availability-load";
import { CatalogView } from "./CatalogView";
import type { WholesaleProduct } from "@/lib/types";
import type { Availability } from "@/lib/availability";

export const dynamic = "force-dynamic";

// Buyer catalog — real synced data from wholesale_products. Middleware has
// already confirmed the visitor is an active buyer; RLS scopes the read.
export default async function CatalogPage() {
  const supabase = createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: buyer }, { data: products }] = await Promise.all([
    supabase.from("buyers").select("id, business_name").eq("email", user.email ?? "").maybeSingle(),
    supabase
      .from("wholesale_products")
      .select("*")
      .eq("wholesale_visible", true)
      .order("category", { nullsFirst: false })
      .order("title", { nullsFirst: false }),
  ]);

  const rows = (products ?? []) as WholesaleProduct[];
  const [cart, availMap] = await Promise.all([
    buyer ? getDetailedCart(buyer.id) : Promise.resolve(null),
    // R7 §9 — one query for the whole page; the raw supply block never leaves
    // availability-load, so no card can serialise vendor detail.
    availabilityForSkus(new Map(rows.map((p) => [p.sku, { currentQty: p.current_qty ?? 0, buyerMoq: p.min_order_qty ?? 1 }]))),
  ]);
  const initialCartBySku: Record<string, number> = {};
  for (const l of cart?.lines ?? []) initialCartBySku[l.product.sku] = l.qty;
  const availabilityBySku: Record<string, Availability> = {};
  for (const [sku, v] of availMap) availabilityBySku[sku] = v.availability;

  return (
    <CatalogView
      businessName={buyer?.business_name ?? "Wholesale"}
      products={rows}
      availabilityBySku={availabilityBySku}
      initialCartBySku={initialCartBySku}
    />
  );
}

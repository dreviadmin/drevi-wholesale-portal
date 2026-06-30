import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { getDetailedCart } from "@/lib/cart";
import { CatalogView } from "./CatalogView";
import type { WholesaleProduct } from "@/lib/types";

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

  const cart = buyer ? await getDetailedCart(buyer.id) : null;
  const initialCartBySku: Record<string, number> = {};
  for (const l of cart?.lines ?? []) initialCartBySku[l.product.sku] = l.qty;

  return (
    <CatalogView
      businessName={buyer?.business_name ?? "Wholesale"}
      products={(products ?? []) as WholesaleProduct[]}
      initialCartBySku={initialCartBySku}
    />
  );
}

import { notFound, redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { getDetailedCart } from "@/lib/cart";
import { availabilityForSku } from "@/lib/availability-load";
import { ProductDetailView } from "./ProductDetailView";
import type { WholesaleProduct } from "@/lib/types";
import { BUYER_PRODUCT_COLUMNS } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: { sku: string } }) {
  const sku = decodeURIComponent(params.sku);
  const supabase = createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: product }, { data: buyer }] = await Promise.all([
    supabase.from("wholesale_products").select(BUYER_PRODUCT_COLUMNS).eq("sku", sku).eq("wholesale_visible", true).maybeSingle(),
    supabase.from("buyers").select("id").eq("email", user.email ?? "").maybeSingle(),
  ]);

  if (!product) notFound();
  const p = product as WholesaleProduct;
  const [cart, avail] = await Promise.all([
    buyer ? getDetailedCart(buyer.id) : Promise.resolve(null),
    availabilityForSku(p.sku, p.current_qty ?? 0, p.min_order_qty ?? 1),
  ]);

  return <ProductDetailView product={p} initialCartCount={cart?.count ?? 0} availability={avail.availability} />;
}

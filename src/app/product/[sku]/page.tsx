import { notFound, redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { getDetailedCart } from "@/lib/cart";
import { ProductDetailView } from "./ProductDetailView";
import type { WholesaleProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: { sku: string } }) {
  const sku = decodeURIComponent(params.sku);
  const supabase = createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: product }, { data: buyer }] = await Promise.all([
    supabase.from("wholesale_products").select("*").eq("sku", sku).eq("wholesale_visible", true).maybeSingle(),
    supabase.from("buyers").select("id").eq("email", user.email ?? "").maybeSingle(),
  ]);

  if (!product) notFound();
  const cart = buyer ? await getDetailedCart(buyer.id) : null;

  return <ProductDetailView product={product as WholesaleProduct} initialCartCount={cart?.count ?? 0} />;
}

import { notFound, redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { getDetailedCart } from "@/lib/cart";
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

  const [{ data: product }, { data: buyerRows }] = await Promise.all([
    supabase.from("wholesale_products").select(BUYER_PRODUCT_COLUMNS).eq("sku", sku).eq("buyer_visible", true).maybeSingle(),
    // The credentialed row, not .maybeSingle() (see cart/page.tsx).
    supabase.from("buyers").select("id").eq("email", user.email ?? "").not("encrypted_password", "is", null).limit(1),
  ]);

  if (!product) notFound();
  const p = product as WholesaleProduct;
  const buyer = buyerRows?.[0] ?? null;
  const cart = buyer ? await getDetailedCart(buyer.id) : null;

  // No availability prop: the buyer surface shows no stock state, and passing it
  // anyway put the literal on-hand count ("Limited - 1 left") into the RSC
  // payload where devtools can read it.
  return <ProductDetailView product={p} initialCartCount={cart?.totalQty ?? 0} />;
}

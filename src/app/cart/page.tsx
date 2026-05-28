import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { getDetailedCart } from "@/lib/cart";
import { CartView } from "./CartView";

export const dynamic = "force-dynamic";

export default async function CartPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: buyer } = await supabase.from("buyers").select("id").eq("email", user.email ?? "").maybeSingle();
  const cart = buyer ? await getDetailedCart(buyer.id) : null;

  return (
    <CartView
      lines={(cart?.lines ?? []).map((l) => ({
        sku: l.product.sku,
        title: l.product.title ?? l.product.sku,
        image: l.product.image_urls?.[0] ?? null,
        unitPrice: l.product.wholesale_price,
        qty: l.qty,
        cap: l.cap,
        moq: l.product.min_order_qty,
        stockState: l.stockState,
        restockDays: l.product.restock_days,
        belowMoq: l.belowMoq,
        lineTotal: l.lineTotal,
      }))}
      subtotal={cart?.subtotal ?? 0}
      maxLeadDays={cart?.maxLeadDays ?? 0}
      hasBlock={cart?.hasBlock ?? false}
    />
  );
}

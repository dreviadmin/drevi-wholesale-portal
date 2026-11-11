import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { getDetailedCart } from "@/lib/cart";
import { cartSettlement } from "@/lib/cart-lines";
import { CartView } from "./CartView";

export const dynamic = "force-dynamic";

export default async function CartPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The credentialed row, not .maybeSingle(): emails are not unique (0007), and
  // with a second row on the same email maybeSingle() errored, buyer came back
  // null and a full cart rendered as "Your cart is empty" with no submit.
  // Same resolution as resolveActiveBuyer in ./actions.
  const { data: rows } = await supabase
    .from("buyers")
    .select("id")
    .eq("email", user.email ?? "")
    .not("encrypted_password", "is", null)
    .limit(1);
  const buyer = rows?.[0] ?? null;
  const cart = buyer ? await getDetailedCart(buyer.id) : null;
  // What changed since the buyer added it (Oct review): named once, then
  // settled by CartView so the notice does not come back on every visit. A
  // cart that could not be read throws here, to the error page, before any of
  // it is named as dropped (see cartSettlement).
  const { changeNotice, droppedSkus, adjustedLines } = cartSettlement(cart);

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
        special: l.special,
        lineTotal: l.lineTotal,
      }))}
      subtotal={cart?.subtotal ?? 0}
      maxLeadDays={cart?.maxLeadDays ?? 0}
      changeNotice={changeNotice}
      droppedSkus={droppedSkus}
      adjustedLines={adjustedLines}
    />
  );
}

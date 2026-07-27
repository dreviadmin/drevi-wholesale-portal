import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadBuyerHome } from "@/lib/buyer-home";
import { getDetailedCart } from "@/lib/cart";
import { BuyerHome } from "./BuyerHome";

export const dynamic = "force-dynamic";

// Buyer storefront home (build guide §13) — replaces catalog-as-landing.
// Buyer URLs are otherwise unchanged (D10); /catalog still works.
export default async function BuyerHomePage() {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("buyers")
    .select("id, business_name, city, status")
    .eq("email", user.email)
    .not("encrypted_password", "is", null)
    .limit(1);
  const buyer = rows?.[0];
  if (!buyer || buyer.status !== "active") redirect("/login");

  const [data, cart] = await Promise.all([loadBuyerHome(buyer.id), getDetailedCart(buyer.id)]);
  const cartCount = cart.totalQty;

  return (
    <BuyerHome
      businessName={buyer.business_name ?? "Your shop"}
      city={buyer.city ?? null}
      cartCount={cartCount}
      data={data}
    />
  );
}

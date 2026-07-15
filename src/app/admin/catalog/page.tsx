import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { StaffCatalogView } from "./StaffCatalogView";
import type { WholesaleProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

// Browse-only catalog for staff/admins — see and search every product at a
// glance without starting a billing session. Open to every staff role.
export default async function StaffCatalogPage() {
  await requireStaff();
  const admin = createAdminClient();
  const { data: products } = await admin
    .from("wholesale_products")
    .select("*")
    .eq("wholesale_visible", true)
    .order("category", { nullsFirst: false })
    .order("title", { nullsFirst: false });

  // Hidden SKUs ride along so a scanned tag can say "hidden" instead of the
  // misleading "not on the portal".
  const { data: hidden } = await admin
    .from("wholesale_products")
    .select("sku")
    .eq("wholesale_visible", false);

  return (
    <StaffCatalogView
      products={(products ?? []) as WholesaleProduct[]}
      hiddenSkus={(hidden ?? []).map((h) => h.sku as string)}
    />
  );
}

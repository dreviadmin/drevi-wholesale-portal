import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { ManageCatalogView } from "./ManageCatalogView";
import type { WholesaleProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

// Manage Catalog — admin/super_admin only. Edit any field of any product;
// manual edits lock that field so a sheet resync won't overwrite it.
export default async function ManageCatalogPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  const { data: products } = await admin
    .from("wholesale_products")
    .select("*")
    .order("wholesale_visible", { ascending: false })
    .order("category", { nullsFirst: false })
    .order("title", { nullsFirst: false });

  return <ManageCatalogView products={(products ?? []) as WholesaleProduct[]} />;
}

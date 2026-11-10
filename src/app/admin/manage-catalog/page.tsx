import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { ManageCatalogView } from "./ManageCatalogView";
import { listKnownHsnCodes } from "@/lib/hsn";
import type { WholesaleProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

// Manage Catalog — admin/super_admin only. Edit any field of any product;
// manual edits lock that field so a sheet resync won't overwrite it.
export default async function ManageCatalogPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  // Paged with fetchAll: a bare select stops at 1,000 rows without a word.
  // SKU ends the sort so no product can fall between two pages or show twice.
  const products = await fetchAll<WholesaleProduct>(admin, "wholesale_products", "*", (q) =>
    q
      .order("buyer_visible", { ascending: false })
      .order("category", { nullsFirst: false })
      .order("title", { nullsFirst: false })
      .order("sku"),
  );

  return <ManageCatalogView products={products} hsnOptions={await listKnownHsnCodes()} />;
}

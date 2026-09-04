import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_HSN } from "@/lib/hsn-default";

// Ansh (4 Sep): a custom line on ANY bill (wholesale wizard or retail
// billing) can opt into the catalog — unchecked by default. The product lands
// HIDDEN (wholesale_visible false) with zero stock: it exists so it can be
// scanned, priced and completed in Manage Catalog, but never surprises the
// buyer catalog. The billed price seeds wholesale_price or the retail price
// depending on which flow created it.

export async function syncCustomToCatalog(args: {
  sku: string;
  title: string;
  unitPrice: number;
  kind: "wholesale" | "retail";
  createdBy?: string | null;
}): Promise<{ ok: boolean; error?: string; created?: boolean }> {
  const sku = args.sku.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{3,40}$/.test(sku)) {
    return { ok: false, error: "Catalog sync needs a real SKU (letters/numbers/dashes, 4+ chars)." };
  }
  if (sku === "CUSTOM" || sku.startsWith("CUSTOM-")) {
    return { ok: false, error: "Give the item its own SKU before syncing to the catalog." };
  }
  const title = args.title.trim();
  if (!title) return { ok: false, error: "A catalog product needs a name." };

  const admin = createAdminClient();
  const { data: existing } = await admin.from("wholesale_products").select("sku").eq("sku", sku).maybeSingle();
  if (existing) return { ok: false, error: `${sku} already exists in the catalog — scan it instead of a custom line.` };

  const { error } = await admin.from("wholesale_products").insert({
    sku,
    title,
    wholesale_price: args.kind === "wholesale" ? Math.max(0, args.unitPrice) : 0,
    wholesale_visible: false,
    current_qty: 0,
    restockable: true,
    min_order_qty: 1,
    hsn: DEFAULT_HSN,
    // The sheet sync must not resurrect/overwrite a portal-born product.
    locked_fields: ["sku", "title", "wholesale_visible"],
  });
  if (error) return { ok: false, error: error.message };

  if (args.kind === "retail" && args.unitPrice > 0) {
    await admin.from("product_vendor_info").upsert(
      { sku, retail_price: args.unitPrice, updated_at: new Date().toISOString() },
      { onConflict: "sku" },
    );
  }
  return { ok: true, created: true };
}

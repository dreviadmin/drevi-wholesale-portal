import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// HSN codes (Ansh, 31 Jul) — one source for the "known codes" dropdown that
// every HSN input offers: the union of codes already on products and codes
// already typed onto order lines. Free entry stays possible; the dropdown just
// keeps 6204 from becoming 6204/62O4/"6204 ".

export async function listKnownHsnCodes(): Promise<string[]> {
  const admin = createAdminClient();
  const codes = new Set<string>();

  const { data: products } = await admin.from("wholesale_products").select("hsn").not("hsn", "is", null);
  for (const p of products ?? []) {
    const v = String(p.hsn ?? "").trim();
    if (v) codes.add(v);
  }

  // Codes staff typed on order lines that never made it onto a product.
  const { data: orders } = await admin.from("orders").select("items").limit(500);
  for (const o of orders ?? []) {
    for (const it of (o.items as { hsn?: string | null }[] | null) ?? []) {
      const v = String(it?.hsn ?? "").trim();
      if (v) codes.add(v);
    }
  }
  return [...codes].sort();
}

import Link from "next/link";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcile } from "@/lib/stock-ledger";
import { palette } from "@/lib/palette";
import { StockTake } from "./StockTake";
import { DriftReport } from "../stock-check/DriftReport";
import type { CountableProduct } from "./actions";

export const dynamic = "force-dynamic";

// Bulk count (14 Sep) — committing a selected-everything take is a serial loop
// of ~3 Supabase round trips per SKU, which the 60s default would cut off part
// way through with no transaction to roll back. StockTake ALSO chunks the
// commit; this is the second belt, not the only one.
export const maxDuration = 300;

// UX sprint (29 Jul) — ONE stock screen. "Count" is the walk-the-rack flow;
// "Check" is the ledger-vs-cache drift report that used to be its own nav
// item. Device/floor scope stays parked (ANSH-20) → admin-role gated.
export default async function StockCountPage({ searchParams }: { searchParams?: { tab?: string } }) {
  await requireAdminOrRedirect();
  const tab = searchParams?.tab === "check" ? "check" : "count";
  const drift = tab === "check" ? await reconcile() : null;
  const catalog = tab === "count" ? await listCountable() : [];

  return (
    <div>
      <div className="px-4 md:px-8 pt-5 flex gap-1.5">
        {([["count", "Count"], ["check", "Check"]] as const).map(([key, label]) => (
          <Link
            key={key}
            href={key === "count" ? "/admin/stock-take" : "/admin/stock-take?tab=check"}
            className="font-body uppercase"
            style={{
              fontSize: 9.5, letterSpacing: "0.16em", padding: "7px 14px",
              background: tab === key ? palette.black : "transparent",
              color: tab === key ? palette.ivory : palette.softBlack,
              border: tab === key ? "none" : "1px solid rgba(26,26,26,0.18)",
            }}
          >
            {label}
          </Link>
        ))}
      </div>
      {tab === "count" ? <StockTake catalog={catalog} /> : <DriftReport checked={drift!.checked} rows={drift!.drift} />}
    </div>
  );
}

// The whole catalog, so the bulk picker has a list to select from. Mirrors
// manage-catalog/page.tsx, but mapped to the scanned-line shape rather than the
// raw row — the count list has to treat a staged SKU and a scanned SKU alike.
// Ordered by SKU so the variants of one design sit together in the picker AND
// in the count list they are staged into, which is what makes correcting L, M
// and XL one after the other possible.
async function listCountable(): Promise<CountableProduct[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("wholesale_products")
    .select("sku, title, current_qty, image_urls, location, category")
    .order("sku");
  return (data ?? []).map((p) => ({
    sku: p.sku,
    title: p.title,
    systemQty: Number(p.current_qty) || 0,
    thumb: (p.image_urls as string[] | null)?.[0] ?? null,
    location: p.location ?? null,
    category: p.category ?? null,
  }));
}

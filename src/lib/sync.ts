import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { readMaster } from "@/lib/sheets";
import { fetchProductImageUrls } from "@/lib/shopify-auth";
import { drivePhotosEnabled, fetchSkuImageBytes } from "@/lib/drive";
import { uploadProductPhoto } from "@/lib/storage";

// Logical key -> Master Sheet display header (matched by suffix). Descriptive
// fields come from the pipeline's known columns; the wholesale-specific columns
// (Final Wholesale, Wholesale Visible, Min Order Qty - Wholesale, Restockable,
// Restock Days, Shopify Live URL) are the portal's own additions per CLAUDE.md.
const COLS: Record<string, string> = {
  sku: "Drevi SKU",
  title: "Product Name",
  description: "Description",
  category: "Category",
  sub_category: "Sub-Category",
  color: "Color",
  primary_fabric: "Primary Fabric",
  current_qty: "Current Qty",
  shopify_product_id: "Shopify Product ID",
  shopify_live_url: "Shopify Live URL",
  shopify_product_url: "Shopify Product URL",
  wholesale_price: "Final Wholesale",
  wholesale_visible: "Wholesale Visible",
  min_order_qty: "Min Order Qty - Wholesale",
  restockable: "Restockable",
  restock_days: "Restock Days",
};

// Columns the sync cannot operate without (they drive the filter / pricing).
const REQUIRED_COLS = ["sku", "shopify_live_url", "wholesale_visible", "wholesale_price"];

// FILTER MODE — diverges from CLAUDE.md's strict filter by explicit decision
// (2026-05-28): the Master Sheet's `Shopify Live URL` and `Wholesale Visible`
// columns are not yet populated (products are still drafts), so the strict
// filter yields 0 rows. RELAXED mode lets the portal run off current data:
//   • visibility: blank is treated as visible (spec §4.1 "Wholesale Visible
//     (default Y)"); only an explicit N hides a product.
//   • live URL: falls back to `Shopify Product URL` when `Shopify Live URL`
//     is empty.
// Flip to true to restore the strict CLAUDE.md filter once the sheet is
// populated and products are published.
const STRICT_FILTER = false;

// Second source: the Wholesale Drevi Product Master (same structure as the
// pipeline Master). Its rows are the wholesale collection itself, so EVERY row
// with a SKU is included — blanks (even price) stay blank per business call
// (13 Jul 2026): prices live on physical tags until the sheet is filled in.
const WHOLESALE_SHEET_ID = process.env.WHOLESALE_SHEET_ID ?? "1HnPYQRDwIxRTjgZ2ic8Bzfchidb1I5bbUdpO7Mbx8I8";

const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refetch images older than 7 days
const IMAGE_FETCH_CONCURRENCY = 2; // Shopify REST allows ~2 calls/sec
// Drive-photo copies per run — keeps the Vercel cron under its 60s cap; the
// 10-min cadence finishes any backlog quickly. Local runs can raise it via env.
const DRIVE_IMAGE_BUDGET = Number(process.env.DRIVE_IMAGE_BUDGET) > 0 ? Number(process.env.DRIVE_IMAGE_BUDGET) : 12;

export interface SyncResult {
  synced: number;
  image_fetches: number;
  hidden: number;
  skipped: number;
  duration_ms: number;
  warnings: string[];
}

function isYes(s: string): boolean {
  const v = (s ?? "").trim().toUpperCase();
  return v === "Y" || v === "YES" || v === "TRUE";
}
function isNo(s: string): boolean {
  const v = (s ?? "").trim().toUpperCase();
  return v === "N" || v === "NO" || v === "FALSE";
}
// Visibility under the active filter mode (see STRICT_FILTER).
function isVisible(s: string): boolean {
  return STRICT_FILTER ? isYes(s) : !isNo(s);
}
function toInt(s: string): number | null {
  const n = parseInt((s ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
function toIntOr0(s: string): number {
  return toInt(s) ?? 0;
}
function toPrice(s: string): number {
  const n = parseFloat((s ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

interface ProductRow {
  sku: string;
  title: string | null;
  description: string | null;
  category: string | null;
  sub_category: string | null;
  color: string | null;
  primary_fabric: string | null;
  wholesale_price: number;
  wholesale_visible: boolean;
  min_order_qty: number | null;
  restockable: boolean;
  restock_days: number | null;
  current_qty: number;
  shopify_product_id: string | null;
  shopify_live_url: string | null;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function syncProducts(): Promise<SyncResult> {
  const start = Date.now();
  const warnings: string[] = [];
  const supabase = createAdminClient();

  const { effectiveHeaders, missing, rows } = await readMaster(COLS);

  // Fail loudly if a required column wasn't found, naming what WAS present.
  const missingRequired = missing.filter((k) => REQUIRED_COLS.includes(k));
  if (missingRequired.length > 0) {
    const present = effectiveHeaders.filter(Boolean).join(", ");
    throw new Error(
      `Sync aborted — required Master columns not found: ${missingRequired
        .map((k) => `"${COLS[k]}"`)
        .join(", ")}. Effective headers present: [${present}]`,
    );
  }
  for (const k of missing) warnings.push(`Optional column not found in sheet: "${COLS[k]}"`);

  // The sheet itself returning no data rows is a hard failure.
  if (rows.length === 0) {
    throw new Error("Sync aborted — the Master tab returned 0 data rows.");
  }

  // Second source: the Wholesale Master. A read failure is a warning, not an
  // abort — the pipeline Master must keep syncing regardless.
  let wholesaleRows: Array<Record<string, string>> = [];
  if (WHOLESALE_SHEET_ID) {
    try {
      const w = await readMaster(COLS, WHOLESALE_SHEET_ID);
      wholesaleRows = w.rows;
    } catch (e) {
      warnings.push(`Wholesale sheet read failed: ${(e as Error).message}`);
    }
  }

  // Filter + map.
  let skipped = 0;
  const products: ProductRow[] = [];
  const included = new Set<string>();

  const push = (row: Record<string, string>, opts: { price: number; liveUrl: string | null; restockable: boolean; restockDays: number | null }) => {
    const sku = row.sku.trim();
    products.push({
      sku,
      title: row.title || null,
      description: row.description || null,
      category: row.category || null,
      sub_category: row.sub_category || null,
      color: row.color || null,
      primary_fabric: row.primary_fabric || null,
      wholesale_price: opts.price,
      wholesale_visible: true,
      min_order_qty: toInt(row.min_order_qty),
      restockable: opts.restockable,
      restock_days: opts.restockable ? opts.restockDays : null,
      current_qty: toIntOr0(row.current_qty),
      shopify_product_id: row.shopify_product_id || null,
      shopify_live_url: opts.liveUrl,
    });
    included.add(sku.toUpperCase());
  };

  // Wholesale Master first (it wins on SKU collisions): every row with a SKU
  // is included unless explicitly hidden; blank price stays 0 (tags carry the
  // real price until the sheet is filled — staff set it at billing).
  for (const row of wholesaleRows) {
    const sku = row.sku?.trim();
    if (!sku || included.has(sku.toUpperCase())) continue;
    if (isNo(row.wholesale_visible)) { skipped++; continue; }
    const restockDays = toInt(row.restock_days);
    // Blank restockable on a zero-qty row would render it "sold out" and make
    // it unorderable in the wizard — treat as made-to-order instead.
    const qty = toIntOr0(row.current_qty);
    const restockable = isYes(row.restockable) || (qty <= 0 && !isNo(row.restockable));
    push(row, {
      price: toPrice(row.wholesale_price),
      liveUrl: row.shopify_live_url?.trim() || row.shopify_product_url?.trim() || null,
      restockable,
      restockDays,
    });
  }

  // Pipeline Master rows keep the original relaxed rules (URL + price gates).
  for (const row of rows) {
    const sku = row.sku?.trim();
    if (!sku || included.has(sku.toUpperCase())) {
      if (sku) skipped++; // collision — wholesale row won
      else skipped++;
      continue;
    }
    const visible = isVisible(row.wholesale_visible);
    const price = toPrice(row.wholesale_price);
    // In relaxed mode, fall back to Shopify Product URL when Live URL is blank.
    const liveUrl = row.shopify_live_url?.trim() || (STRICT_FILTER ? "" : row.shopify_product_url?.trim());

    if (!liveUrl || !visible || price <= 0) {
      skipped++;
      continue;
    }

    const restockable = isYes(row.restockable);
    const restockDays = toInt(row.restock_days);
    if (restockable && restockDays === null) {
      warnings.push(`SKU ${sku}: restockable but no restock_days — row skipped.`);
      skipped++;
      continue;
    }

    push(row, { price, liveUrl: liveUrl || null, restockable, restockDays });
  }

  if (products.length === 0) {
    warnings.push("No rows qualified (Shopify Live URL set AND Wholesale Visible=Y AND Final Wholesale>0).");
  }

  // Existing image cache for the qualifying SKUs.
  const skus = products.map((p) => p.sku);
  const existingBySku = new Map<string, { image_urls: string[]; images_fetched_at: string | null }>();
  if (skus.length > 0) {
    const { data: existing } = await supabase
      .from("wholesale_products")
      .select("sku, image_urls, images_fetched_at")
      .in("sku", skus);
    for (const e of existing ?? []) {
      existingBySku.set(e.sku, {
        image_urls: Array.isArray(e.image_urls) ? (e.image_urls as string[]) : [],
        images_fetched_at: e.images_fetched_at,
      });
    }
  }

  // Decide which SKUs need a fresh image fetch. images_fetched_at is the cache
  // signal — a product with no images in Shopify still records a fetch time, so
  // we retry it on the 7-day TTL rather than every run.
  const now = Date.now();
  const needsImages = products.filter((p) => {
    if (!p.shopify_product_id) return false;
    const ex = existingBySku.get(p.sku);
    if (!ex || !ex.images_fetched_at) return true;
    return now - new Date(ex.images_fetched_at).getTime() > IMAGE_TTL_MS;
  });

  let imageFetches = 0;
  const freshImages = new Map<string, string[]>();
  await mapWithConcurrency(needsImages, IMAGE_FETCH_CONCURRENCY, async (p) => {
    try {
      const urls = await fetchProductImageUrls(p.shopify_product_id!);
      freshImages.set(p.sku, urls);
      imageFetches++;
    } catch (err) {
      warnings.push(`Image fetch failed for ${p.sku}: ${(err as Error).message}`);
    }
  });

  // Drive fallback: products with no Shopify product (the Wholesale Master
  // rows) get their photo from the per-SKU Drive folder, copied ONCE into the
  // public product-photos bucket so the URL behaves like any CDN image
  // (catalog, wizard, invoice PDF). images_fetched_at gives misses the same
  // 7-day retry as Shopify. Budgeted per run to stay inside the cron timeout.
  if (drivePhotosEnabled()) {
    const needsDrive = products
      .filter((p) => {
        if (p.shopify_product_id) return false; // Shopify owns these
        const ex = existingBySku.get(p.sku);
        if (ex && ex.image_urls.length > 0) return false; // already has a photo
        if (!ex || !ex.images_fetched_at) return true;
        return now - new Date(ex.images_fetched_at).getTime() > IMAGE_TTL_MS;
      })
      .slice(0, DRIVE_IMAGE_BUDGET);
    await mapWithConcurrency(needsDrive, 3, async (p) => {
      try {
        const img = await fetchSkuImageBytes(p.sku, 800);
        if (img) {
          const url = await uploadProductPhoto(p.sku, Buffer.from(img.body), img.contentType);
          freshImages.set(p.sku, [url]);
        } else {
          freshImages.set(p.sku, []); // no folder/photo — record the attempt (TTL retry)
        }
        imageFetches++;
      } catch (err) {
        warnings.push(`Drive photo failed for ${p.sku}: ${(err as Error).message}`);
      }
    });
  }

  // Build upsert payload — every row carries image columns (fresh, or carried
  // forward from cache) so a bulk upsert never nulls existing images.
  const nowIso = new Date().toISOString();
  const payload = products.map((p) => {
    const fresh = freshImages.get(p.sku);
    const ex = existingBySku.get(p.sku);
    const image_urls = fresh && fresh.length > 0 ? fresh : ex?.image_urls ?? [];
    const images_fetched_at = fresh ? nowIso : ex?.images_fetched_at ?? null;
    return { ...p, image_urls, images_fetched_at, synced_at: nowIso };
  });

  if (payload.length > 0) {
    const { error } = await supabase.from("wholesale_products").upsert(payload, { onConflict: "sku" });
    if (error) throw new Error(`Upsert failed: ${error.message}`);
  }

  // Hide SKUs previously visible but no longer qualifying (preserve order history).
  //
  // Guardrail: a transiently bad sheet (formula errors, a cleared column, a
  // half-saved edit) can yield zero or very few qualifying rows. Without this
  // check the hide pass would blank the entire storefront until the next good
  // sync — and orders placed in that window silently drop items. So we refuse
  // to hide when nothing qualified, or when a single run would hide more than
  // half of what's currently visible; the run still upserts the good rows and
  // records a loud warning instead.
  let hidden = 0;
  const { data: visibleRows } = await supabase
    .from("wholesale_products")
    .select("sku")
    .eq("wholesale_visible", true);
  const visibleCount = (visibleRows ?? []).length;
  const qualifying = new Set(skus);
  const toHide = (visibleRows ?? []).map((r) => r.sku).filter((s) => !qualifying.has(s));

  const wouldHideAll = qualifying.size === 0 && toHide.length > 0;
  const wouldHideMost = visibleCount > 0 && toHide.length > Math.max(5, Math.floor(visibleCount * 0.5));

  if (wouldHideAll || wouldHideMost) {
    warnings.push(
      `Hide pass SKIPPED — would have hidden ${toHide.length} of ${visibleCount} visible products ` +
        `(only ${qualifying.size} qualified). Suspected bad sheet; storefront left intact. ` +
        `Check the Master tab's Wholesale Visible / Live URL / Final Wholesale columns.`,
    );
  } else if (toHide.length > 0) {
    const { error } = await supabase
      .from("wholesale_products")
      .update({ wholesale_visible: false, synced_at: nowIso })
      .in("sku", toHide);
    if (error) throw new Error(`Hide-missing update failed: ${error.message}`);
    hidden = toHide.length;
  }

  return {
    synced: payload.length,
    image_fetches: imageFetches,
    hidden,
    skipped,
    duration_ms: Date.now() - start,
    warnings,
  };
}

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
  // Procurement columns → product_vendor_info (admin dashboard only; cost
  // price never touches wholesale_products, which buyer pages select("*")).
  vendor_name: "Vendor Name",
  vendor_id: "Vendor ID",
  vendor_sku: "Vendor SKU",
  last_cost: "Last Cost",
  last_receipt_date: "Last Receipt Date",
  retail_price: "Final MRP",
};

// Columns the sync cannot operate without (they drive the filter / pricing).
const REQUIRED_COLS = ["sku", "shopify_live_url", "wholesale_visible", "wholesale_price"];

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
const DRIVE_MISS_RETRY_MS = 30 * 60 * 1000; // photo not found → look again in 30 min

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

export async function syncProducts(opts?: { driveBudget?: number }): Promise<SyncResult> {
  const start = Date.now();
  const warnings: string[] = [];
  const supabase = createAdminClient();

  // SOLE source: the Wholesale Master (business call 13 Jul 2026 — the portal
  // carries only the wholesale collection; pipeline-Master retail rows were
  // removed). Same structure as the pipeline Master.
  const { effectiveHeaders, missing, rows: wholesaleRows } = await readMaster(COLS, WHOLESALE_SHEET_ID);

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
  if (wholesaleRows.length === 0) {
    throw new Error("Sync aborted — the Wholesale Master tab returned 0 data rows.");
  }

  // SKUs an admin renamed in Manage Catalog — the sheet still carries the old
  // name; skip those rows so they can't resurrect as duplicates. A failed
  // read MUST abort the run: proceeding with an empty set would re-create
  // every renamed SKU as a duplicate visible product.
  const { data: ignoredRows, error: ignoredErr } = await supabase.from("sync_ignored_skus").select("sku");
  if (ignoredErr) throw new Error(`Sync aborted — ignored-SKU read failed: ${ignoredErr.message}`);
  const ignored = new Set((ignoredRows ?? []).map((r) => r.sku.toUpperCase()));

  // Filter + map.
  let skipped = 0;
  const products: ProductRow[] = [];
  const included = new Set<string>();
  // Vendor/procurement columns for the admin dashboard's reorder table —
  // separate table, sheet is the source of truth (no locked_fields).
  const vendorInfo: Array<Record<string, unknown>> = [];
  const seenVendor = new Set<string>();

  const push = (row: Record<string, string>, opts: { price: number; liveUrl: string | null; restockable: boolean; restockDays: number | null }) => {
    // Canonicalize to uppercase — the PK is case-sensitive, and every set/map
    // (included, ignored, qualifying, existingBySku, onConflict) keys on the
    // uppercase form. Storing mixed case here would split a re-cased sheet SKU
    // into a duplicate row and drop its locks. (See migration 0011.)
    const sku = row.sku.trim().toUpperCase();
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

  // Every row with a SKU is included unless explicitly hidden or ignored;
  // blank price stays 0 (tags carry the real price until the sheet is filled —
  // staff set it at billing).
  for (const row of wholesaleRows) {
    const sku = row.sku?.trim();
    if (!sku || included.has(sku.toUpperCase())) continue;
    if (ignored.has(sku.toUpperCase())) { skipped++; continue; }
    // Vendor/retail info covers EVERY sheet row — a garment hidden from the
    // wholesale portal still hangs in the retail shop, and Retail Price Check
    // must resolve its tag.
    if (!seenVendor.has(sku.toUpperCase())) {
      seenVendor.add(sku.toUpperCase());
      vendorInfo.push({
        sku: sku.toUpperCase(),
        vendor_name: row.vendor_name || null,
        vendor_id: row.vendor_id || null,
        vendor_sku: row.vendor_sku || null,
        last_cost: toPrice(row.last_cost),
        last_receipt_date: row.last_receipt_date || null,
        retail_price: toPrice(row.retail_price),
      });
    }
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

  if (products.length === 0) {
    warnings.push("No wholesale rows qualified (need a Drevi SKU; Wholesale Visible must not be N).");
  }

  // Existing rows for the qualifying SKUs — image cache + locked fields (admin
  // manual edits the sync must not overwrite).
  const skus = products.map((p) => p.sku);
  type ExistingRow = { image_urls: string[]; images_fetched_at: string | null; locked_fields: string[] } & Record<string, unknown>;
  const existingBySku = new Map<string, ExistingRow>();
  if (skus.length > 0) {
    // A failed read here MUST abort the run: an empty map would make the
    // upsert below blank every cached image and erase every manual-edit lock
    // across the catalog — one transient DB blip nuking admin work.
    const { data: existing, error: existingErr } = await supabase
      .from("wholesale_products")
      .select("*")
      .in("sku", skus);
    if (existingErr) throw new Error(`Sync aborted — existing-rows read failed: ${existingErr.message}`);
    for (const e of existing ?? []) {
      existingBySku.set(e.sku, {
        ...e,
        image_urls: Array.isArray(e.image_urls) ? (e.image_urls as string[]) : [],
        images_fetched_at: e.images_fetched_at,
        locked_fields: Array.isArray(e.locked_fields) ? (e.locked_fields as string[]) : [],
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
        if (ex?.locked_fields.includes("image_urls")) return false; // admin owns these
        if (ex && ex.image_urls.length > 0) return false; // already has a photo
        if (!ex || !ex.images_fetched_at) return true;
        // A photo MISS retries fast (folders are being added all day); a hit
        // would only refresh on the long TTL, but hits are excluded above.
        return now - new Date(ex.images_fetched_at).getTime() > DRIVE_MISS_RETRY_MS;
      })
      .slice(0, opts?.driveBudget ?? DRIVE_IMAGE_BUDGET);
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
  // forward from cache) so a bulk upsert never nulls existing images. Fields an
  // admin locked in Manage Catalog keep their existing DB value: the sheet no
  // longer controls them until unlocked.
  const nowIso = new Date().toISOString();
  const payload = products.map((p) => {
    const fresh = freshImages.get(p.sku);
    const ex = existingBySku.get(p.sku);
    const image_urls = fresh && fresh.length > 0 ? fresh : ex?.image_urls ?? [];
    const images_fetched_at = fresh ? nowIso : ex?.images_fetched_at ?? null;
    // Every row must carry locked_fields: PostgREST unifies columns across a
    // bulk upsert, so ONE brand-new sheet SKU (no existing row → key absent)
    // would null the column for itself and abort the whole sync on NOT NULL.
    const row: Record<string, unknown> = { ...p, image_urls, images_fetched_at, synced_at: nowIso, locked_fields: ex?.locked_fields ?? [] };
    if (ex) {
      for (const f of ex.locked_fields) {
        if (f === "image_urls") {
          row.image_urls = ex.image_urls;
          row.images_fetched_at = ex.images_fetched_at;
        } else if (f in ex) {
          row[f] = ex[f];
        }
      }
    }
    return row;
  });

  if (payload.length > 0) {
    const { error } = await supabase.from("wholesale_products").upsert(payload, { onConflict: "sku" });
    if (error) throw new Error(`Upsert failed: ${error.message}`);
  }

  // Vendor info is best-effort — a failure here must not abort the product sync.
  if (vendorInfo.length > 0) {
    const stamped = vendorInfo.map((v) => ({ ...v, updated_at: nowIso }));
    const { error } = await supabase.from("product_vendor_info").upsert(stamped, { onConflict: "sku" });
    if (error) warnings.push(`Vendor-info upsert failed: ${error.message}`);
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
    .select("sku, locked_fields")
    .eq("wholesale_visible", true);
  const visibleCount = (visibleRows ?? []).length;
  const qualifying = new Set(skus);
  // Never auto-hide a product the admin manages directly: one whose visibility
  // is locked (they chose to show it), or whose SKU was renamed in Manage
  // Catalog (its new SKU isn't in the sheet, but it's not gone — it's ours now).
  const adminOwned = (lf: unknown) => Array.isArray(lf) && (lf.includes("wholesale_visible") || lf.includes("sku"));
  const toHide = (visibleRows ?? [])
    .filter((r) => !qualifying.has(r.sku) && !adminOwned(r.locked_fields))
    .map((r) => r.sku);

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

// Fast path for the Retail Price Check "Sync Prices" button: read ONLY the
// SKU + Final MRP columns and update retail_price. Touches nothing else (no
// photos, no product upserts, no locked-field logic) so it returns in ~2s —
// staff type a price into the sheet and see it on the shop floor immediately.
export async function syncRetailPrices(): Promise<{
  updated: number;
  duration_ms: number;
  prices: { sku: string; retail_price: number }[];
  asOf: string;
}> {
  const start = Date.now();
  const supabase = createAdminClient();
  const { rows } = await readMaster({ sku: COLS.sku, retail_price: COLS.retail_price }, WHOLESALE_SHEET_ID);
  const nowIso = new Date().toISOString();
  const seen = new Set<string>();
  const payload: Array<{ sku: string; retail_price: number; updated_at: string }> = [];
  for (const r of rows) {
    const sku = r.sku?.trim().toUpperCase();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    payload.push({ sku, retail_price: toPrice(r.retail_price), updated_at: nowIso });
  }
  if (payload.length > 0) {
    const { error } = await supabase.from("product_vendor_info").upsert(payload, { onConflict: "sku" });
    if (error) throw new Error(`Retail price upsert failed: ${error.message}`);
  }
  return {
    updated: payload.length,
    duration_ms: Date.now() - start,
    prices: payload.map(({ sku, retail_price }) => ({ sku, retail_price })),
    asOf: nowIso,
  };
}

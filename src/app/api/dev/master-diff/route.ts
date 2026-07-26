import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { readMaster } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WHOLESALE_SHEET_ID = process.env.WHOLESALE_SHEET_ID ?? "1HnPYQRDwIxRTjgZ2ic8Bzfchidb1I5bbUdpO7Mbx8I8";

// Stage 8 §12.4 parallel week — sheet-vs-Supabase divergence report. Run it
// daily (or on demand) into docs/CUTOVER-LOG.md; ANSH-07 wants five clean
// consecutive days before the flip. Admin+ (it exposes costs).
export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  try {
    const { rows } = await readMaster(
      { sku: "Drevi SKU", wholesale_price: "Final Wholesale", retail_price: "Final MRP", current_qty: "Current Qty", wholesale_visible: "Wholesale Visible" },
      WHOLESALE_SHEET_ID,
    );
    const sheetBySku = new Map(
      rows
        .filter((r) => r.sku?.trim())
        .map((r) => [r.sku.trim().toUpperCase(), {
          ws: parseFloat((r.wholesale_price ?? "").replace(/[₹,\s]/g, "")) || 0,
          mrp: parseFloat((r.retail_price ?? "").replace(/[₹,\s]/g, "")) || 0,
          qty: parseInt((r.current_qty ?? "").replace(/[^\d-]/g, ""), 10) || 0,
        }]),
    );

    const admin = createAdminClient();
    const app = await fetchAll<{ sku: string; wholesale_price: number; current_qty: number; effective_mrp: number | null; sheet_retail_price: number | null }>(
      admin, "products_master_view", "sku, wholesale_price, current_qty, effective_mrp, sheet_retail_price",
    );

    const diffs: { sku: string; field: string; sheet: number; app: number }[] = [];
    for (const a of app) {
      const s = sheetBySku.get(a.sku.toUpperCase());
      if (!s) continue;
      if (Math.abs(s.ws - (a.wholesale_price ?? 0)) > 0.5) diffs.push({ sku: a.sku, field: "wholesale_price", sheet: s.ws, app: a.wholesale_price ?? 0 });
      if (Math.abs(s.qty - (a.current_qty ?? 0)) > 0) diffs.push({ sku: a.sku, field: "current_qty", sheet: s.qty, app: a.current_qty ?? 0 });
      if (a.effective_mrp != null && s.mrp > 0 && Math.abs(s.mrp - Number(a.effective_mrp)) > 0.5) {
        diffs.push({ sku: a.sku, field: "mrp", sheet: s.mrp, app: Number(a.effective_mrp) });
      }
    }
    return NextResponse.json({
      date: new Date().toISOString().slice(0, 10),
      skusCompared: app.filter((a) => sheetBySku.has(a.sku.toUpperCase())).length,
      diffCount: diffs.length,
      clean: diffs.length === 0,
      diffs: diffs.slice(0, 100),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

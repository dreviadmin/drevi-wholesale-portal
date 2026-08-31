import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { getEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SHEET_ID = process.env.WHOLESALE_SHEET_ID ?? "1HnPYQRDwIxRTjgZ2ic8Bzfchidb1I5bbUdpO7Mbx8I8";
const TAB = "App Mirror";

// Stage 8 §12.3 — nightly one-way mirror: Supabase → the "App Mirror" tab on
// the Wholesale Master sheet. Comfort + backup during the transition; ships
// BEFORE the cutover so the team watches it working. Requires the service
// account to hold EDITOR on the wholesale sheet (parked as ANSH-11 if not).
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${getEnv("CRON_SECRET")}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const admin = createAdminClient();
    const rows = await fetchAll<Record<string, unknown>>(
      admin,
      "products_master_view",
      "sku, base_sku, color, title, category, sub_category, fabric, handwork, origin, specs_verified, tier, markup_multiplier, auto_mrp, mrp_override, effective_mrp, wholesale_price, current_qty, wholesale_visible, last_cost, sheet_retail_price, vendor_name, vendor_sku",
    );

    const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
    const sa = JSON.parse(raw.startsWith("{") ? raw : readFileSync(raw, "utf8"));
    const jwt = new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    await jwt.authorize();
    const sheets = google.sheets({ version: "v4", auth: jwt });

    // Ensure the tab exists.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: "sheets(properties(title))" });
    if (!meta.data.sheets?.some((s) => s.properties?.title === TAB)) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] } });
    }

    const header = [
      "SKU", "Base SKU", "Color", "Title", "Category", "Sub-Category", "Fabric", "Handwork", "Origin",
      "Specs Verified", "Tier", "Markup ×", "Auto MRP", "MRP Override", "Effective MRP",
      "Wholesale", "Qty", "Visible", "Last Cost", "Sheet MRP", "Vendor", "Vendor SKU",
    ];
    const banner = [`MIRROR — exported from the Drevi App ${new Date().toISOString()}. Edits here do nothing.`];
    const values: (string | number | boolean | null)[][] = [
      banner,
      header,
      ...rows.map((r) => [
        r.sku, r.base_sku, r.color, r.title, r.category, r.sub_category, r.fabric, r.handwork, r.origin,
        r.specs_verified ? "Y" : "N", r.tier, r.markup_multiplier, r.auto_mrp, r.mrp_override, r.effective_mrp,
        r.wholesale_price, r.current_qty, r.wholesale_visible ? "Y" : "N", r.last_cost, r.sheet_retail_price,
        r.vendor_name, r.vendor_sku,
      ] as (string | number | boolean | null)[]),
    ];

    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${TAB}!A:Z` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
    return NextResponse.json({ mirrored: rows.length });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

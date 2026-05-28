/**
 * Read-only diagnostic: confirm the Master tab has the columns the sync needs
 * and report how many rows qualify. Does NOT touch Supabase. Mirrors the
 * column resolution in src/lib/sheets.ts + src/lib/sync.ts.
 *
 *   node scripts/probe-sheet.mjs
 */
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const COLS = {
  sku: "Drevi SKU",
  title: "Product Name",
  current_qty: "Current Qty",
  shopify_product_id: "Shopify Product ID",
  shopify_product_url: "Shopify Product URL",
  shopify_live_url: "Shopify Live URL",
  wholesale_price: "Final Wholesale",
  wholesale_visible: "Wholesale Visible",
  min_order_qty: "Min Order Qty - Wholesale",
  restockable: "Restockable",
  restock_days: "Restock Days",
};
const REQUIRED = ["sku", "shopify_live_url", "wholesale_visible", "wholesale_price"];

function findColumn(headers, needle) {
  const n = (needle ?? "").trim();
  if (!n) return 0;
  for (let i = 0; i < headers.length; i++) if (headers[i] === n) return i + 1;
  const suffix = "/" + n;
  for (let i = 0; i < headers.length; i++) if (headers[i]?.endsWith(suffix)) return i + 1;
  return 0;
}
function buildEffectiveHeaders(row1, row2) {
  const width = Math.max(row1.length, row2.length);
  const out = [];
  let section = "";
  for (let i = 0; i < width; i++) {
    const s = (row1[i] ?? "").trim();
    if (s) section = s;
    const col = (row2[i] ?? "").trim();
    out.push(!col ? "" : section ? `${section}/${col}` : col);
  }
  return out;
}
function colLetter(col) {
  let s = "";
  while (col > 0) {
    const r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}
const isYes = (s) => ["Y", "YES", "TRUE"].includes((s ?? "").trim().toUpperCase());
const isNo = (s) => ["N", "NO", "FALSE"].includes((s ?? "").trim().toUpperCase());
const toPrice = (s) => {
  const n = parseFloat((s ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

async function main() {
  const saPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!saPath || !sheetId) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SHEET_ID");
  const sa = JSON.parse(saPath.trim().startsWith("{") ? saPath : readFileSync(saPath, "utf8"));

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  await auth.authorize();
  const sheets = google.sheets({ version: "v4", auth });

  console.log(`Service account: ${sa.client_email}`);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Master", valueRenderOption: "FORMATTED_VALUE" });
  const values = res.data.values ?? [];
  console.log(`Master tab: ${values.length} total rows (incl. 2 header rows)\n`);

  const headers = buildEffectiveHeaders(values[0] ?? [], values[1] ?? []);
  console.log("Column resolution:");
  const resolved = {};
  for (const [key, header] of Object.entries(COLS)) {
    const col = findColumn(headers, header);
    resolved[key] = col;
    const req = REQUIRED.includes(key) ? " (required)" : "";
    console.log(`  ${key.padEnd(20)} "${header}"  ->  ${col ? colLetter(col) : "*** MISSING ***"}${req}`);
  }

  const missingRequired = REQUIRED.filter((k) => !resolved[k]);
  if (missingRequired.length) {
    console.log(`\n*** Required columns MISSING: ${missingRequired.join(", ")} ***`);
    console.log("Effective headers present:\n  " + headers.filter(Boolean).join(" | "));
    return;
  }

  const data = values.slice(2);
  let qualifying = 0;
  let relaxed = 0;
  const samples = [];
  // per-condition breakdown (independent counts, among rows with a SKU)
  let withSku = 0, liveSet = 0, visibleY = 0, priceGt0 = 0, restockSet = 0, pidSet = 0, purlSet = 0;
  const visibleVals = {}, rawSamples = [];
  for (const raw of data) {
    const get = (k) => (resolved[k] > 0 ? (raw[resolved[k] - 1] ?? "").toString().trim() : "");
    if (get("sku")) withSku++; else continue;
    if (get("shopify_live_url")) liveSet++;
    if (isYes(get("wholesale_visible"))) visibleY++;
    if (toPrice(get("wholesale_price")) > 0) priceGt0++;
    if (get("restockable")) restockSet++;
    if (get("shopify_product_id")) pidSet++;
    if (get("shopify_product_url")) purlSet++;
    const vv = get("wholesale_visible") || "(blank)";
    visibleVals[vv] = (visibleVals[vv] ?? 0) + 1;
    if (rawSamples.length < 5)
      rawSamples.push({ sku: get("sku"), live: get("shopify_live_url") ? "set" : "", visible: get("wholesale_visible"), finalWhsl: get("wholesale_price"), restock: get("restockable") });
  }
  console.log(`\nBreakdown (among ${withSku} rows with a SKU):`);
  console.log(`  Shopify Live URL non-empty : ${liveSet}`);
  console.log(`  Wholesale Visible = Y      : ${visibleY}`);
  console.log(`  Final Wholesale > 0        : ${priceGt0}`);
  console.log(`  Restockable non-empty      : ${restockSet}`);
  console.log(`  Shopify Product ID set     : ${pidSet}`);
  console.log(`  Shopify Product URL set    : ${purlSet}`);
  console.log(`  Wholesale Visible values   : ${JSON.stringify(visibleVals)}`);
  console.log(`  First rows (sku/live/visible/finalWholesale/restockable):`);
  for (const s of rawSamples) console.log("    " + JSON.stringify(s));

  for (const raw of data) {
    const get = (k) => (resolved[k] > 0 ? (raw[resolved[k] - 1] ?? "").toString().trim() : "");
    const sku = get("sku");
    const liveUrl = get("shopify_live_url");
    const visible = isYes(get("wholesale_visible"));
    const price = toPrice(get("wholesale_price"));
    if (sku && liveUrl && visible && price > 0) qualifying++;

    // Relaxed mode: live URL OR product URL, blank visible treated as Y.
    const effLive = liveUrl || get("shopify_product_url");
    const relVisible = !isNo(get("wholesale_visible"));
    if (sku && effLive && relVisible && price > 0) {
      relaxed++;
      if (samples.length < 3) {
        samples.push({ sku, price, restockable: get("restockable") || "(blank)", restock_days: get("restock_days") || "(blank)", qty: get("current_qty"), pid: get("shopify_product_id") });
      }
    }
  }
  console.log(`\nData rows: ${data.length}`);
  console.log(`STRICT qualifying  (Live URL AND Visible=Y AND price>0): ${qualifying}`);
  console.log(`RELAXED qualifying (Live|Product URL AND not-N AND price>0): ${relaxed}`);
  if (samples.length) {
    console.log("\nSample qualifying rows:");
    for (const s of samples) console.log("  " + JSON.stringify(s));
  }
}

main().catch((e) => {
  console.error("\nProbe failed:", e.message);
  process.exit(1);
});

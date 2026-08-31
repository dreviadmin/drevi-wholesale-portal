/**
 * R0 — retrofit baseline (retrofit spec §1). Read-only introspection of the
 * environment named by NEXT_PUBLIC_SUPABASE_URL; writes docs/RETROFIT-BASELINE.md.
 *
 *   npm run retrofit:baseline           (dev, via .env.development.local)
 *
 * Repo convention is .mjs scripts (see scripts/*.mjs) — the spec's .ts name is
 * adapted, logged in docs/DECISIONS.md.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.development.local" });
dotenv.config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
const db = createClient(url, key, { global: { fetch: (u, i) => fetch(u, { ...i, cache: "no-store" }) } });

async function sql(query) {
  if (!token) return null;
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function count(table, apply) {
  let q = db.from(table).select("*", { count: "exact", head: true });
  if (apply) q = apply(q);
  const { count: n, error } = await q;
  return error ? `ERROR: ${error.message}` : n;
}

async function groupCount(table, column, extra) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(column).range(from, from + 999);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) return { ERROR: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const out = {};
  for (const r of rows) {
    const k = String(r[column] ?? "—");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const TABLES = [
  "sku_registry", "vendors", "goods_receipts", "goods_receipt_lines", "designs",
  "design_angles", "image_candidates", "design_images", "design_copy",
  "publish_targets", "pipeline_jobs", "product_images", "devices",
  "wholesale_products", "orders", "buyers", "notify_me", "stock_movements",
];

(async () => {
  const lines = [];
  const p = (s = "") => lines.push(s);

  p("# Retrofit baseline (R0)");
  p("");
  p(`Generated ${new Date().toISOString()} · project \`${ref}\``);
  p("");

  // --- migrations ---
  const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  p("## Migrations");
  p("");
  p(`- Files on disk: ${files.length}, max \`${files[files.length - 1]}\``);
  p("");

  // --- tables ---
  p("## Tables & row counts");
  p("");
  p("| Table | Present | Rows |");
  p("|---|---|---|");
  const present = {};
  for (const t of TABLES) {
    const n = await count(t);
    const ok = typeof n === "number";
    present[t] = ok;
    p(`| \`${t}\` | ${ok ? "yes" : "**NO**"} | ${ok ? n : "—"} |`);
  }
  p("");

  // --- detail groupings ---
  p("## Detail");
  p("");
  const imagesTable = present.design_images ? "design_images" : "image_candidates";
  p(`- \`design_angles\` by angle: \`${JSON.stringify(await groupCount("design_angles", "angle"))}\``);
  p(`- \`${imagesTable}\` by status: \`${JSON.stringify(await groupCount(imagesTable, "status"))}\``);
  if (present.design_images) {
    p(`- \`design_images\` by role: \`${JSON.stringify(await groupCount("design_images", "role"))}\``);
  }
  p(`- \`publish_targets\` by portal: \`${JSON.stringify(await groupCount("publish_targets", "portal"))}\``);
  p(`- \`publish_targets\` by state: \`${JSON.stringify(await groupCount("publish_targets", "state"))}\``);
  p(`- \`designs\` specs_verified: \`${JSON.stringify(await groupCount("designs", "specs_verified"))}\``);
  p(`- \`designs\` tier: \`${JSON.stringify(await groupCount("designs", "tier"))}\``);
  const stocked = await count("wholesale_products", (q) => q.gt("current_qty", 0));
  p(`- \`wholesale_products\` with stock > 0: **${stocked}**`);
  const angleSources = await count("design_angles", (q) => q.not("source_ref", "is", null));
  p(`- \`design_angles\` with a legacy \`source_ref\`: **${angleSources}**`);
  const approved = await count("design_angles", (q) => q.not("approved_candidate_id", "is", null).limit(1));
  p(`- \`design_angles\` with an approved image: **${approved}**`);
  p("");

  // --- columns of interest (assumption checks) ---
  p("## Assumption checks");
  p("");
  const colRows = await sql(`select table_name, column_name from information_schema.columns
    where table_schema='public' and table_name in ('design_angles','image_candidates','design_images','designs','goods_receipt_lines','goods_receipts','wholesale_products')
    order by table_name, column_name`);
  const cols = {};
  for (const r of colRows ?? []) (cols[r.table_name] ??= []).push(r.column_name);
  const has = (t, c) => (cols[t] ?? []).includes(c);
  const checks = [
    ["A1 · Stage 8 cutover complete", `SHEET_SYNC_ENABLED=${process.env.SHEET_SYNC_ENABLED ?? "(unset → sync ON)"}`],
    ["A2 · images status/source_ref shape", `${imagesTable}.status present=${has(imagesTable, "status")}, design_angles.source_ref present=${has("design_angles", "source_ref")}`],
    ["A3 · angle set", JSON.stringify(Object.keys(await groupCount("design_angles", "angle")))],
    ["A4 · receipts do not write products", "receipt save writes only receipt tables (verified by code read)"],
    ["A5 · buyer storefront reads product_images", `product_images rows=${await count("product_images")}`],
  ];
  p("| Assumption | Observed |");
  p("|---|---|");
  for (const [k, v] of checks) p(`| ${k} | ${v} |`);
  p("");

  // --- flags ---
  p("## Flags");
  p("");
  p("| Flag | Value |");
  p("|---|---|");
  for (const f of ["SHEET_SYNC_ENABLED", "SKU_DUAL_MODE", "SHOPIFY_ENABLED", "OPENAI_BG_ENABLED", "RECEIPT_INTAKE_V2", "DRIVE_DESIGN_FOLDER_ID", "DRIVE_PHOTOS_FOLDER_ID"]) {
    const v = process.env[f];
    p(`| \`${f}\` | ${v ? (f.includes("FOLDER") ? "set" : v) : "*(unset)*"} |`);
  }
  p("");

  // --- legacy drive ---
  p("## Legacy Drive");
  p("");
  const withFolder = await count("designs", (q) => q.not("drive_input_id", "is", null));
  const withTryon = await count("designs", (q) => q.not("drive_tryon_id", "is", null));
  const withProcessed = await count("designs", (q) => q.not("drive_processed_id", "is", null));
  p(`- designs linked to a legacy INPUT folder: **${withFolder}**`);
  p(`- linked to TRYON: **${withTryon}** · to PHOTOS/processed: **${withProcessed}**`);
  const imgRows = await count(imagesTable);
  p(`- \`${imagesTable}\` rows (all hold Drive file ids that stay valid across folder moves): **${imgRows}**`);
  p("");

  writeFileSync("docs/RETROFIT-BASELINE.md", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log("\n→ docs/RETROFIT-BASELINE.md written");
})();

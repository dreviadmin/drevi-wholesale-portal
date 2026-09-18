/**
 * Which SKUs still have NO photo anywhere? (Rakesh, 17 Sep.)
 *
 * The imagery rule promises that a SKU with at least one image ends up with
 * both a thumbnail and a front. It promises nothing to a SKU with no image at
 * all — those need a human with a camera, and this is the list of them.
 *
 *   node scripts/imagery-report.mjs [--prod] [--all]
 *
 * READ-ONLY. It never writes to the database — the only thing it produces is a
 * CSV under .local/ (gitignored), so it is safe to run against production.
 * --all lists every SKU in the table rather than only the ones with no image.
 *
 * Four channels are checked per SKU, because "has an image" is true if ANY of
 * them holds one:
 *   1 catalog     wholesale_products.image_urls[0]  (the board thumbnail)
 *   2 drive       design_images rows created by the Drive sync
 *   3 identifier  designs.ident_image_id
 *   4 uploaded    design_images rows from a portal upload or a backfill
 *
 * A SKU is joined to its design by the (base|color) group key — the SAME walk
 * loadBoard uses, so "no image" here means exactly what the board shows.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const SHOW_ALL = process.argv.includes("--all");

// TARGET SELECTION — dev is the default, prod needs an explicit flag.
const target = process.argv.includes("--prod") || process.env.DB_TARGET === "prod" ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
dotenv.config({ path: envFile, override: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envFile}`);
  process.exit(1);
}
const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? "unknown";
console.log(`Target: ${target.toUpperCase()} (${envFile}, project ${ref}) · READ-ONLY`);

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

// PostgREST silently caps unpaginated selects at 1000 rows — page explicitly,
// or every SKU past the cap looks like it has no photos at all.
async function pageAll(table, cols, apply) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(cols).range(from, from + 999);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) { console.error(`${table} read failed: ${error.message}`); process.exit(1); }
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

const [products, designs, images, angles] = await Promise.all([
  pageAll("wholesale_products", "sku, image_urls"),
  pageAll("designs", "id, base_sku, color, title, ident_image_id"),
  pageAll("design_images", "id, design_id, role, created_by, status", (q) => q.eq("status", "active")),
  pageAll("design_angles", "design_id, angle, source_ref, approved_image_id"),
]);

// Rows the Drive sync registered vs rows a person (or a backfill) put there.
// created_by is the only signal that separates them, and it is set by every
// writer we control; an unrecognised value is treated as a manual upload
// because a human is the default author of a photo in this system.
const DRIVE_AUTHORS = new Set(["drive-sync"]);
const byDesign = new Map();
for (const i of images) {
  if (!i.design_id) continue;
  const e = byDesign.get(i.design_id) ?? { drive: 0, uploaded: 0 };
  if (DRIVE_AUTHORS.has(i.created_by)) e.drive++;
  else e.uploaded++;
  byDesign.set(i.design_id, e);
}

// A front that is filled counts as an image even if its row is somehow absent.
const frontFilled = new Set();
for (const a of angles) {
  if (a.angle === "front" && (a.approved_image_id || a.source_ref)) frontFilled.add(a.design_id);
}

const designByGroup = new Map();
for (const d of designs) designByGroup.set(`${d.base_sku.toUpperCase()}|${d.color.toUpperCase()}`, d);

const rows = [];
for (const p of products) {
  const parts = p.sku.toUpperCase().split("-");
  // Same guard as loadBoard: a SKU that does not parse has no design group.
  const parsed = parts.length >= 5 && /^\d{2,4}$/.test(parts[3]);
  const key = parsed ? `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}` : null;
  const design = key ? designByGroup.get(key) ?? null : null;
  const counts = design ? byDesign.get(design.id) ?? { drive: 0, uploaded: 0 } : { drive: 0, uploaded: 0 };

  const catalog = !!(p.image_urls ?? [])[0];
  const drive = counts.drive > 0;
  const identifier = !!design?.ident_image_id;
  const uploaded = counts.uploaded > 0;
  const front = design ? frontFilled.has(design.id) : false;
  const any = catalog || drive || identifier || uploaded || front;

  rows.push({
    sku: p.sku,
    designId: design?.id ?? "",
    title: design?.title ?? "",
    group: key ?? "(unparsed SKU)",
    catalog, drive, identifier, uploaded, front, any,
  });
}

rows.sort((a, b) => a.sku.localeCompare(b.sku));
const none = rows.filter((r) => !r.any);
const noDesign = rows.filter((r) => !r.designId);

const pct = (n) => (rows.length ? ((n / rows.length) * 100).toFixed(1) : "0.0");
console.log(`\nSKUs in wholesale_products: ${rows.length}`);
console.log(`  with an image on any channel : ${rows.length - none.length} (${pct(rows.length - none.length)}%)`);
console.log(`  with NO image anywhere       : ${none.length} (${pct(none.length)}%)`);
console.log(`\nBy channel (a SKU can appear in several):`);
console.log(`  catalog thumbnail : ${rows.filter((r) => r.catalog).length}`);
console.log(`  drive photos      : ${rows.filter((r) => r.drive).length}`);
console.log(`  identifier        : ${rows.filter((r) => r.identifier).length}`);
console.log(`  uploaded photos   : ${rows.filter((r) => r.uploaded).length}`);
console.log(`  front filled      : ${rows.filter((r) => r.front).length}`);
if (noDesign.length) console.log(`\n${noDesign.length} SKU(s) have no design row at all — they cannot carry imagery until one exists.`);

const shown = SHOW_ALL ? rows : none;
if (shown.length) {
  const mark = (b) => (b ? "y" : "·");
  const w = Math.max(3, ...shown.map((r) => r.sku.length));
  console.log(`\n${SHOW_ALL ? "Every SKU" : "SKUs with NO image anywhere"} (cat/drv/ident/upl/front):\n`);
  console.log(`  ${"SKU".padEnd(w)}  c d i u f  design`);
  for (const r of shown.slice(0, 200)) {
    console.log(`  ${r.sku.padEnd(w)}  ${mark(r.catalog)} ${mark(r.drive)} ${mark(r.identifier)} ${mark(r.uploaded)} ${mark(r.front)}  ${r.title || r.group}${r.designId ? "" : "  [no design row]"}`);
  }
  if (shown.length > 200) console.log(`  … and ${shown.length - 200} more — see the CSV.`);
} else {
  console.log(`\nEvery SKU has at least one image.`);
}

// CSV so the owner can work through it offline. .local/ is gitignored.
const esc = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = "sku,design_id,title,group,catalog,drive,identifier,uploaded,front_filled,has_any_image";
const csv = [header, ...rows.map((r) => [r.sku, r.designId, r.title, r.group, r.catalog, r.drive, r.identifier, r.uploaded, r.front, r.any].map(esc).join(","))].join("\n");
mkdirSync(".local", { recursive: true });
const out = `.local/imagery-report-${target}.csv`;
writeFileSync(out, `${csv}\n`, "utf8");
console.log(`\nCSV written: ${out} (all ${rows.length} SKUs, has_any_image=false are the gaps)`);

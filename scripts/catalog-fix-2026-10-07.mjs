/**
 * One-off backfill for the two 7 Oct 2026 fixes. Dry run unless --write.
 *
 *   node scripts/catalog-fix-2026-10-07.mjs                  # DEV, dry run
 *   node scripts/catalog-fix-2026-10-07.mjs --prod --write
 *   ... --only DD-SUT-PLZ-028-PUR      (one design: BASE-COLOR)
 *
 * 1. Minted rows. A SKU minted in Log delivery (registry row + app-born
 *    design) whose delivery was never saved had no catalog row, so it could
 *    not be billed or added to an order (DD-SAR-PRD-099-L-BGE). Creates the
 *    row exactly as src/lib/catalog-row.ts now does at mint time.
 * 2. Catalog fronts. Puts each unpublished design's Studio front photo first
 *    in image_urls of its sizes (DD-SUT-PLZ-028 PUR showed another garment's
 *    sheet photo). Same path, version and lock as src/lib/studio/catalog-front.ts,
 *    so the app sees the result as already in sync.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import sharp from "sharp";
import dotenv from "dotenv";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const flag = (f) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : null; };
const target = has("prod") ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
if (!existsSync(envFile)) { console.error(`${envFile} not found — refusing to guess which project to touch.`); process.exit(1); }
// Drive credentials are account-level and live in .env.local; the target file wins on the project.
if (existsSync(".env.local")) dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ path: envFile, override: true, quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (target === "dev" && url?.includes("cofarxgywnrdjbizxbxw")) { console.error("Dev run resolved to the PROD project — refusing."); process.exit(1); }
const write = has("write");
const only = flag("only")?.toUpperCase() ?? null;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
console.log(`Target: ${target.toUpperCase()} · ${write ? "WRITING" : "dry run"}${only ? ` · only ${only}` : ""}`);

async function all(table, cols, order, filter) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    let q = admin.from(table).select(cols).order(order).range(i, i + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
const keyOf = (sku) => { const p = sku.trim().toUpperCase().split("-"); return p.length < 5 ? null : `${p.slice(0, 4).join("-")}|${p[p.length - 1]}`; };

const designs = await all("designs", "id, base_sku, color, title, origin_source, discontinued_at", "id");
const products = await all("wholesale_products", "sku, image_urls, locked_fields, wholesale_price", "sku");
const registry = await all("sku_registry", "variant_sku", "variant_sku");
const designByKey = new Map(designs.map((d) => [`${d.base_sku}|${d.color}`.toUpperCase(), d]));
const productsByKey = new Map();
for (const p of products) { const k = keyOf(p.sku); if (!k) continue; if (!productsByKey.has(k)) productsByKey.set(k, []); productsByKey.get(k).push(p); }
const haveRow = new Set(products.map((p) => p.sku.toUpperCase()));
const inScope = (k) => !only || k.replace("|", "-") === only;

// ---- 1. Minted rows -------------------------------------------------------
console.log("\n1. Minted SKUs with no catalog row (app-born designs only):");
let created = 0;
for (const r of registry) {
  const sku = r.variant_sku.toUpperCase();
  const k = keyOf(sku);
  if (!k || haveRow.has(sku) || !inScope(k)) continue;
  const d = designByKey.get(k);
  if (!d || d.origin_source !== "app" || d.discontinued_at) continue;
  const prices = new Set((productsByKey.get(k) ?? []).map((p) => Number(p.wholesale_price) || 0).filter((n) => n > 0));
  const price = prices.size === 1 ? [...prices][0] : 0;
  console.log(`  ${sku}  "${d.title ?? ""}"  price ${price || "unset"}`);
  if (!write) continue;
  const { error } = await admin.from("wholesale_products").insert({
    sku: r.variant_sku, hsn: null, title: d.title?.trim() || null, category: null, sub_category: null, color: d.color,
    wholesale_price: price, wholesale_visible: true, current_qty: 0, restockable: true,
    locked_fields: price > 0 ? ["wholesale_visible", "wholesale_price"] : ["wholesale_visible"], synced_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") console.error(`    FAILED: ${error.message}`); else created++;
}

// ---- 2. Catalog fronts ----------------------------------------------------
let drive = null;
async function driveBytes(fileId) {
  if (!drive) {
    const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
    const creds = JSON.parse(raw.startsWith("{") ? raw : readFileSync(raw, "utf8"));
    drive = google.drive({ version: "v3", auth: new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive.readonly"] }) });
  }
  const r = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
  return Buffer.from(r.data);
}
async function refBytes(ref) {
  if (!ref.startsWith("sb:")) return driveBytes(ref);
  const rest = ref.slice(3);
  const head = rest.split(":", 1)[0];
  const known = ["design-images", "vendor-photos", "order-attachments", "note-photos"];
  const [bucket, path] = known.includes(head) ? [head, rest.slice(head.length + 1)] : ["design-images", rest];
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`storage ${bucket}/${path}: ${error?.message ?? "missing"}`);
  return Buffer.from(await data.arrayBuffer());
}

const targets = await all("publish_targets", "design_id, portal, state", "design_id", (q) => q.eq("portal", "wholesale"));
const liveDesign = new Set(targets.filter((t) => t.state === "live" || t.state === "changes_pending").map((t) => t.design_id));
const fronts = await all("design_angles", "design_id, approved_image_id, source_ref", "design_id", (q) => q.eq("angle", "front"));
const frontByDesign = new Map(fronts.map((f) => [f.design_id, f]));
const approvedIds = fronts.map((f) => f.approved_image_id).filter(Boolean);
const approvedRef = new Map();
for (let i = 0; i < approvedIds.length; i += 200) {
  const { data } = await admin.from("design_images").select("id, file_ref").in("id", approvedIds.slice(i, i + 200));
  for (const x of data ?? []) approvedRef.set(x.id, x.file_ref);
}

console.log("\n2. Unpublished designs whose catalog thumbnail is not their Studio front:");
let synced = 0, failed = 0;
for (const d of designs) {
  const k = `${d.base_sku}|${d.color}`.toUpperCase();
  if (d.discontinued_at || liveDesign.has(d.id) || !inScope(k)) continue;
  const group = productsByKey.get(k) ?? [];
  if (!group.length) continue;
  const f = frontByDesign.get(d.id);
  const ref = (f?.approved_image_id && approvedRef.get(f.approved_image_id)) || f?.source_ref || null;
  if (!ref) continue;
  const version = createHash("sha1").update(ref).digest("hex").slice(0, 10);
  const inSync = group.every((p) => { const u = p.image_urls?.[0]; return typeof u === "string" && u.includes("/catalog_front-") && u.endsWith(`?v=${version}`); });
  if (inSync) continue;
  console.log(`  ${d.base_sku}-${d.color}  ${group.length} size(s)  front: ${f.approved_image_id ? "approved image" : "source photo"}`);
  if (!write) continue;
  try {
    const jpg = await sharp(await refBytes(ref)).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const safe = (s) => s.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
    const path = `${safe(d.base_sku)}-${safe(d.color)}/catalog_front-1200.jpg`;
    const up = await admin.storage.from("product-images").upload(path, jpg, { contentType: "image/jpeg", upsert: true });
    if (up.error) throw new Error(up.error.message);
    const publicUrl = `${admin.storage.from("product-images").getPublicUrl(path).data.publicUrl}?v=${version}`;
    for (const p of group) {
      const old = Array.isArray(p.image_urls) ? p.image_urls : [];
      const locks = new Set(Array.isArray(p.locked_fields) ? p.locked_fields : []); locks.add("image_urls");
      const { error } = await admin.from("wholesale_products").update({ image_urls: [publicUrl, ...old.filter((u) => !String(u).includes("/catalog_front-"))], locked_fields: [...locks] }).eq("sku", p.sku);
      if (error) throw new Error(error.message);
    }
    synced++;
  } catch (e) { failed++; console.error(`    FAILED: ${e.message}`); }
}
console.log(`\n${write ? "Done" : "Dry run"}: ${created} row(s) created, ${synced} design(s) synced, ${failed} failed.`);

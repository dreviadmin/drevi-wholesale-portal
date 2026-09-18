/**
 * Direction B of "front = thumbnail" (owner, 17 Sep): a design whose wholesale
 * group already shows a catalog photo (wholesale_products.image_urls[0]) but
 * whose Studio front is empty gets that photo COPIED into the design's own
 * imagery — bytes land in the portal's design-images bucket (an "sb:" ref the
 * whole app already serves), a design_images row is registered, and the front
 * angle's source is seeded. Direction A (front exists, catalog photo missing)
 * needs no data change — the board falls back to the front image at render.
 *
 *   node scripts/backfill-front-from-thumbnail.mjs [--dry-run] [--prod]
 *
 * Seeds the SOURCE and the identifier only, never approved_image_id: under the
 * 17 Sep effective-image semantics the source already counts as filled, and
 * the stamp stays a human choice between candidates.
 * Idempotent — once the front has a source the design stops matching, and a
 * partial earlier run is detected by the row this script signs (created_by),
 * so nothing is downloaded or inserted twice.
 *
 * The image URL comes from our own DB, but it is treated as untrusted anyway:
 * https only, an EXACT hostname allowlist, an image content-type and a size
 * cap — a poisoned row must fail loudly here, not become portal imagery.
 */
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const DRY_RUN = process.argv.includes("--dry-run");

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
console.log(`Target: ${target.toUpperCase()} (${envFile}, project ${ref}) · ${DRY_RUN ? "DRY-RUN" : "WRITE"}`);

if (target === "prod" && !DRY_RUN) {
  console.log("\n⚠  PRODUCTION — this copies catalog photos into design imagery and seeds front pointers on live designs.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "backfill production fronts" to continue: ');
  rl.close();
  if (answer.trim() !== "backfill production fronts") {
    console.log("Aborted — nothing changed.");
    process.exit(1);
  }
}

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const BUCKET = "design-images";
const SIGNATURE = "backfill-front-from-thumbnail"; // created_by marker → idempotent partial-run recovery
// EXACT hostnames the bytes may come from — both Supabase projects' public
// storage and the Shopify CDN. Anything else fails the design, loudly.
const ALLOWED_HOSTS = new Set([
  "qvnvxcdyvcsgxulbcmzm.supabase.co",
  "cofarxgywnrdjbizxbxw.supabase.co",
  "cdn.shopify.com",
]);
const MAX_BYTES = 25 * 1024 * 1024;

// PostgREST silently caps unpaginated selects at 1000 rows — page explicitly.
async function pageAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).range(from, from + 999);
    if (error) { console.error(`${table} read failed: ${error.message}`); process.exit(1); }
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function readWorld() {
  const [designs, angles, images, products] = await Promise.all([
    pageAll("designs", "id, base_sku, color, ident_image_id"),
    pageAll("design_angles", "id, design_id, angle, source_ref, source_image_id, approved_image_id"),
    pageAll("design_images", "id, design_id, file_ref, status, created_by"),
    pageAll("wholesale_products", "sku, image_urls"),
  ]);
  const fronts = new Map(angles.filter((a) => a.angle === "front").map((a) => [a.design_id, a]));
  // First catalog photo per (base|color) group — same key walk as loadBoard.
  const groupThumb = new Map();
  for (const p of products) {
    const parts = p.sku.toUpperCase().split("-");
    if (parts.length < 5 || !/^\d{2,4}$/.test(parts[3])) continue;
    const key = `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`;
    const img = (p.image_urls ?? [])[0];
    if (img && !groupThumb.has(key)) groupThumb.set(key, img);
  }
  // A row this script wrote in an earlier (possibly interrupted) run.
  const priorRun = new Map();
  for (const i of images) {
    if (i.created_by === SIGNATURE && i.status === "active" && !priorRun.has(i.design_id)) priorRun.set(i.design_id, i);
  }
  return { designs, fronts, groupThumb, priorRun };
}

// Direction B = catalog photo exists, front has no EFFECTIVE image (approved
// candidate or source) — same test loadBoard's filled slot uses.
function planFor(world, design) {
  const front = world.fronts.get(design.id) ?? null;
  const frontFilled = !!(front && (front.approved_image_id || front.source_ref));
  const thumb = world.groupThumb.get(`${design.base_sku}|${design.color}`) ?? null;
  return { front, frontFilled, thumb, isDirectionB: !!thumb && !frontFilled };
}

function stats(world) {
  let directionB = 0;
  for (const d of world.designs) if (planFor(world, d).isDirectionB) directionB++;
  return { directionB };
}

/** Untrusted-URL fetch: https, exact allowlisted host, image content, size cap. */
async function fetchAllowed(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error(`not a URL: ${rawUrl.slice(0, 80)}`); }
  if (parsed.protocol !== "https:") throw new Error(`refused non-https URL (${parsed.protocol})`);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new Error(`host not allowlisted: ${parsed.hostname}`);
  const res = await fetch(parsed.href, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!/^image\/(png|jpe?g|webp)$/.test(contentType)) throw new Error(`not an image: ${contentType || "(no content-type)"}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0 || body.length > MAX_BYTES) throw new Error(`bad size: ${body.length} bytes`);
  return { body, contentType };
}

const extFor = (contentType) => (contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg");

/** Next free NN for front__src__NN.<ext> — mirrors design-image-store's nextStorageName. */
async function nextStorageName(designId, ext) {
  const { data, error } = await db.storage.from(BUCKET).list(designId, { limit: 1000 });
  if (error) throw new Error(`bucket list failed: ${error.message}`);
  const stem = "front__src__";
  let max = 0;
  for (const f of data ?? []) {
    const m = f.name.match(new RegExp(`^${stem}(\\d+)\\.`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${stem}${String(max + 1).padStart(2, "0")}.${ext}`;
}

const world = await readWorld();
const before = stats(world);
console.log(`\nBefore: ${world.designs.length} design(s) · ${before.directionB} direction B (catalog photo, empty front)\n`);

let seeded = 0, identSet = 0, reused = 0, failed = 0;
for (const d of world.designs) {
  const plan = planFor(world, d);
  if (!plan.isDirectionB) continue;
  const name = `${d.base_sku}-${d.color}`;

  try {
    // A prior interrupted run may have stored the file and row already — reuse
    // that row instead of downloading a duplicate.
    let row = world.priorRun.get(d.id) ?? null;
    if (row) reused++;
    console.log(`  ${name}: front source ← ${row ? `existing ${row.file_ref}` : plan.thumb.slice(0, 100)}`);
    if (DRY_RUN) { seeded++; if (!d.ident_image_id) identSet++; continue; }

    if (!row) {
      const img = await fetchAllowed(plan.thumb);
      const fileName = await nextStorageName(d.id, extFor(img.contentType));
      const path = `${d.id}/${fileName}`;
      const { error: upErr } = await db.storage.from(BUCKET).upload(path, img.body, { contentType: img.contentType, upsert: false });
      if (upErr) throw new Error(`upload failed: ${upErr.message}`);
      const { data: inserted, error: insErr } = await db
        .from("design_images")
        .insert({ design_id: d.id, angle_id: null, role: "source", file_ref: `sb:${path}`, file_name: fileName, status: "active", created_by: SIGNATURE })
        .select("id, file_ref")
        .single();
      if (insErr) throw new Error(`design_images insert failed: ${insErr.message}`);
      row = inserted;
    }

    // Seed the front source (row exists → update; missing → conflict-ignored
    // upsert), exactly like ensureDesignImagery. NEVER approved_image_id.
    const patch = { source_image_id: row.id, source_ref: row.file_ref, updated_at: new Date().toISOString() };
    const { error: frontErr } = plan.front
      ? await db.from("design_angles").update(patch).eq("id", plan.front.id)
      : await db.from("design_angles").upsert({ design_id: d.id, angle: "front", ...patch }, { onConflict: "design_id,angle", ignoreDuplicates: true });
    if (frontErr) throw new Error(`front seed failed: ${frontErr.message}`);
    seeded++;

    if (!d.ident_image_id) {
      // Compare-and-set: an ident uploaded between our read and this write wins.
      const { data: hit, error: identErr } = await db.from("designs").update({ ident_image_id: row.id }).eq("id", d.id).is("ident_image_id", null).select("id");
      if (identErr) console.log(`    ident skipped — ${identErr.message}`);
      else identSet += (hit ?? []).length;
    }
  } catch (err) {
    failed++;
    console.log(`    FAILED — ${err.message}`);
  }
}

console.log(`\n${DRY_RUN ? "Would seed" : "Seeded"}: ${seeded} front source(s) · ${identSet} identifier(s)${reused ? ` · ${reused} reused from a prior run` : ""}.`);
if (failed) console.log(`${failed} design(s) failed — re-run to retry; nothing is written twice.`);

const after = DRY_RUN ? null : stats(await readWorld());
if (after) console.log(`After: ${after.directionB} direction B remaining.`);
else console.log(`After (projected): ${before.directionB - seeded} direction B remaining.`);
console.log("Approval is untouched — the seeded photo publishes as the effective front until a candidate replaces it.");

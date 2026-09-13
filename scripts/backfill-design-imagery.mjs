/**
 * Repair every design that breaks the imagery rule (Rakesh, 14 Sep): if a SKU
 * has at least one photo, neither its identifier nor its front image may be
 * blank. The app enforces this from now on; this fixes the rows that predate it
 * — 141 of the 142 dev designs with photos had no identifier.
 *
 *   node scripts/backfill-design-imagery.mjs [--dry-run] [--prod]
 *
 * Seeds the SOURCE and the identifier only, never approved_image_id: approval
 * is a human quality gate and an auto-approved photo would publish unreviewed.
 * Idempotent — a second run has nothing to do.
 *
 * DELIBERATE DUPLICATION: the rule itself lives in src/lib/design-imagery.ts
 * (ensureDesignImagery), which is server-only TypeScript and cannot be imported
 * into a plain .mjs script. pickPhoto() and planFor() below reimplement the
 * SAME preference order and the same blank tests. Change them together.
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
  console.log("\n⚠  PRODUCTION — this writes identifier and front-source pointers on live designs.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "backfill production imagery" to continue: ');
  rl.close();
  if (answer.trim() !== "backfill production imagery") {
    console.log("Aborted — nothing changed.");
    process.exit(1);
  }
}

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

// PostgREST silently caps unpaginated selects at 1000 rows — page explicitly,
// or everything past the cap looks like it has no photos at all.
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
  const [designs, images, angles] = await Promise.all([
    pageAll("designs", "id, base_sku, color, ident_image_id"),
    pageAll("design_images", "id, design_id, role, file_ref, file_name, status, created_at"),
    pageAll("design_angles", "id, design_id, angle, source_ref, source_image_id, approved_image_id"),
  ]);
  const byId = new Map(images.map((i) => [i.id, i]));
  const pool = new Map(); // design_id -> usable photos, oldest first
  for (const i of images) {
    if (i.status !== "active" || i.role === "candidate" || !i.file_ref) continue;
    if (!pool.has(i.design_id)) pool.set(i.design_id, []);
    pool.get(i.design_id).push(i);
  }
  for (const list of pool.values()) {
    list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  }
  const fronts = new Map(angles.filter((a) => a.angle === "front").map((a) => [a.design_id, a]));
  return { designs, byId, pool, fronts };
}

const usable = (byId, id) => {
  const row = id ? byId.get(id) : null;
  return row && row.file_ref && row.status !== "rejected" ? row : null;
};

/** Mirrors pickPhoto() in src/lib/design-imagery.ts — same order, same tests. */
function pickPhoto(world, design, front) {
  for (const id of [front?.approved_image_id, front?.source_image_id, design.ident_image_id]) {
    const hit = usable(world.byId, id);
    if (hit) return hit;
  }
  return (world.pool.get(design.id) ?? [])[0] ?? null;
}

function planFor(world, design) {
  const front = world.fronts.get(design.id) ?? null;
  const identBlank = !design.ident_image_id;
  const frontBlank = !front || (!front.source_ref && !front.approved_image_id);
  const hasPhotos = (world.pool.get(design.id) ?? []).length > 0;
  if (!identBlank && !frontBlank) return { front, identBlank, frontBlank, hasPhotos, picked: null };
  return { front, identBlank, frontBlank, hasPhotos, picked: pickPhoto(world, design, front) };
}

function stats(world) {
  let withPhotos = 0, blankIdent = 0, blankFront = 0;
  for (const d of world.designs) {
    const p = planFor(world, d);
    if (!p.hasPhotos) continue;
    withPhotos++;
    if (p.identBlank) blankIdent++;
    if (p.frontBlank) blankFront++;
  }
  return { withPhotos, blankIdent, blankFront };
}

const world = await readWorld();
const before = stats(world);
console.log(`\nBefore: ${world.designs.length} design(s) · ${before.withPhotos} with photos · ${before.blankIdent} blank identifier · ${before.blankFront} blank front\n`);

let identSet = 0, frontSeeded = 0, frontCreated = 0, failed = 0;
for (const d of world.designs) {
  const plan = planFor(world, d);
  if (!plan.identBlank && !plan.frontBlank) continue;
  // No photo anywhere — the rule promises nothing for these.
  if (!plan.picked) continue;
  const name = `${d.base_sku}-${d.color}`;
  const photo = plan.picked.file_name || plan.picked.file_ref;
  const steps = [];
  if (plan.identBlank) steps.push(`ident ← ${photo}`);
  if (plan.frontBlank) steps.push(plan.front ? `front source ← ${photo}` : `front row created, source ← ${photo}`);
  console.log(`  ${name}: ${steps.join(" · ")}`);
  if (DRY_RUN) {
    if (plan.identBlank) identSet++;
    if (plan.frontBlank) { frontSeeded++; if (!plan.front) frontCreated++; }
    continue;
  }

  if (plan.identBlank) {
    // Compare-and-set, exactly as the app does: an ident written since our read wins.
    const { data, error } = await db.from("designs").update({ ident_image_id: plan.picked.id }).eq("id", d.id).is("ident_image_id", null).select("id");
    if (error) { console.log(`    ident failed — ${error.message}`); failed++; }
    else identSet += (data ?? []).length;
  }
  if (plan.frontBlank) {
    const patch = { source_image_id: plan.picked.id, source_ref: plan.picked.file_ref, updated_at: new Date().toISOString() };
    const { data, error } = plan.front
      ? await db.from("design_angles").update(patch).eq("id", plan.front.id).select("id")
      : await db.from("design_angles").upsert({ design_id: d.id, angle: "front", ...patch }, { onConflict: "design_id,angle", ignoreDuplicates: true }).select("id");
    if (error) { console.log(`    front failed — ${error.message}`); failed++; }
    else {
      frontSeeded += (data ?? []).length;
      if (!plan.front) frontCreated += (data ?? []).length;
    }
  }
}

console.log(`\n${DRY_RUN ? "Would set" : "Set"}: ${identSet} identifier(s) · ${frontSeeded} front source(s), of which ${frontCreated} needed a new front angle row.`);
if (failed) console.log(`${failed} write(s) failed — re-run to retry.`);

const after = DRY_RUN ? null : stats(await readWorld());
if (after) {
  console.log(`After: ${after.withPhotos} design(s) with photos · ${after.blankIdent} blank identifier · ${after.blankFront} blank front`);
} else {
  console.log(`After (projected): ${before.withPhotos} with photos · ${before.blankIdent - identSet} blank identifier · ${before.blankFront - frontSeeded} blank front`);
}
console.log("Approval is untouched — every seeded photo still waits for a human to approve it.");

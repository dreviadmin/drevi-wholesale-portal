/**
 * Ansh (4 Aug) — photos placed straight into wholesale_photos never became
 * picker options: the workbench pool reads design_images, and only uploads
 * made THROUGH the portal wrote rows. This backfills every design:
 *
 *   node scripts/ingest-drive-photos.mjs [--write] [--prod]
 *
 * For each design: match its BASE-COLOR folder (same rules as the app's
 * matchFolder — exact group / base-only / single variant; ambiguity skipped
 * and reported), store drive_folder_id, list the folder's images (top level
 * only — _archive/ is a child folder and never appears), and insert a
 * design_images row (role 'source', created_by 'drive-ingest') for every
 * file the DB doesn't already reference. DRY-RUN by default. Idempotent.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const target = args.includes("--prod") ? "prod" : "dev";
dotenv.config({ path: ".env.local" });
if (target === "dev") dotenv.config({ path: ".env.development.local", override: true });

const FOLDER = process.env.DRIVE_DESIGN_FOLDER_ID;
if (!FOLDER) { console.error("DRIVE_DESIGN_FOLDER_ID not set."); process.exit(1); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
console.log(`Drive photo ingest → ${target.toUpperCase()} ${WRITE ? "· WRITE" : "· DRY-RUN"} · folder ${FOLDER}`);

async function driveApi() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  const creds = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse((await import("node:fs")).readFileSync(raw, "utf8"));
  const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: ["https://www.googleapis.com/auth/drive"] });
  return google.drive({ version: "v3", auth });
}
const drive = await driveApi();

async function listAll(q, fields) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({ q, fields: `nextPageToken, files(${fields})`, pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

// Mirrors matchFolder() in src/lib/drive-design.ts.
const normKey = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
function match(folders, base, color) {
  const b = base.trim().toUpperCase(), c = color.trim().toUpperCase();
  const group = normKey(`${b}-${c}`);
  let hit = folders.filter((f) => normKey(f.name) === group);
  if (hit.length === 1) return { id: hit[0].id, rule: "exact" };
  if (hit.length > 1) return { rule: "ambiguous" };
  hit = folders.filter((f) => normKey(f.name) === normKey(b));
  if (hit.length === 1) return { id: hit[0].id, rule: "base" };
  if (hit.length > 1) return { rule: "ambiguous" };
  hit = folders.filter((f) => { const n = f.name.trim().toUpperCase(); return n.startsWith(`${b}-`) && n.endsWith(`-${c}`); });
  if (hit.length === 1) return { id: hit[0].id, rule: "variant" };
  return { rule: hit.length > 1 ? "ambiguous" : "none" };
}

const folders = await listAll(`'${FOLDER}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, "id,name");
console.log(`${folders.length} design folders in Drive`);

// PostgREST silently caps unpaginated selects at 1000 rows — page explicitly,
// or the dedupe map goes blind past the cap and a re-run duplicates rows
// (review finding, 4 Aug; sibling scripts already page the same way).
async function pageAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).range(from, from + 999);
    if (error) { console.error(`${table} read failed: ${error.message}`); process.exit(1); }
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
const designs = await pageAll("designs", "id, base_sku, color, drive_folder_id");
const allRefs = await pageAll("design_images", "design_id, file_ref");
const known = new Map(); // design_id -> Set(file_ref)
for (const r of allRefs) {
  if (!known.has(r.design_id)) known.set(r.design_id, new Set());
  known.get(r.design_id).add(r.file_ref);
}

let linked = 0, added = 0, noFolder = 0, ambiguous = 0;
const misses = [];
for (const d of designs) {
  let folderId = d.drive_folder_id;
  if (!folderId) {
    const m = match(folders, d.base_sku, d.color);
    if (m.rule === "ambiguous") { ambiguous++; misses.push(`${d.base_sku}-${d.color}: ambiguous`); continue; }
    if (!m.id) { noFolder++; continue; }
    folderId = m.id;
    if (WRITE) await db.from("designs").update({ drive_folder_id: folderId }).eq("id", d.id);
    linked++;
  }
  const files = await listAll(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`, "id,name");
  const have = known.get(d.id) ?? new Set();
  const fresh = files.filter((f) => !have.has(f.id));
  if (fresh.length === 0) continue;
  if (WRITE) {
    const rows = fresh.map((f) => ({ design_id: d.id, role: "source", file_ref: f.id, file_name: f.name, status: "active", created_by: "drive-ingest" }));
    // Conflict-ignore under the 0040 unique index — a row that appeared since
    // our read (portal upload, concurrent sync) is skipped, not duplicated.
    const { data: written, error } = await db
      .from("design_images")
      .upsert(rows, { onConflict: "design_id,file_ref", ignoreDuplicates: true })
      .select("id");
    if (error) { misses.push(`${d.base_sku}-${d.color}: insert failed — ${error.message}`); continue; }
    added += (written ?? []).length;
    console.log(`  ${d.base_sku}-${d.color}: +${(written ?? []).length} (${files.length} in folder)`);
  } else {
    added += fresh.length;
    console.log(`  ${d.base_sku}-${d.color}: +${fresh.length} (${files.length} in folder)`);
  }
}

console.log(`\n${WRITE ? "Done" : "Would do"}: linked ${linked} folder id(s), registered ${added} photo(s).`);
console.log(`No folder found: ${noFolder} design(s) · ambiguous: ${ambiguous}`);
if (misses.length) { console.log("Attention:"); for (const m of misses) console.log("  - " + m); }

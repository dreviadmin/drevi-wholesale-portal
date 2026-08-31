/**
 * Productionization (Ansh's plan §1) — move portal-storage photos into the
 * consolidated wholesale_photos Drive folder.
 *
 *   node scripts/migrate-photos-to-drive.mjs [--write] [--prod]
 *
 * Prereqs: DRIVE_DESIGN_FOLDER_ID set to the new Shared-Drive folder, shared
 * to the service account as Content Manager. DRY-RUN by default.
 *
 * For every design_images row whose file_ref starts "sb:" (portal storage):
 *   1. download from the design-images bucket
 *   2. upload into the design's BASE-COLOR folder (created if missing)
 *   3. rewrite file_ref to the Drive id — only after the upload succeeded
 * The storage object stays in place as a belt-and-braces backup; nothing is
 * deleted. Re-runs skip rows that already carry Drive refs.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { Readable } from "node:stream";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const target = args.includes("--prod") ? "prod" : "dev";
dotenv.config({ path: ".env.local" });
if (target === "dev") dotenv.config({ path: ".env.development.local", override: true });

const FOLDER = process.env.DRIVE_DESIGN_FOLDER_ID;
if (!FOLDER) {
  console.error("DRIVE_DESIGN_FOLDER_ID is not set — supply the wholesale_photos Shared-Drive folder id first.");
  process.exit(1);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
console.log(`Photo migration → ${target.toUpperCase()} ${WRITE ? "· WRITE" : "· DRY-RUN"} · Drive folder ${FOLDER}`);

async function driveApi() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  const creds = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse((await import("node:fs")).readFileSync(raw, "utf8"));
  const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: ["https://www.googleapis.com/auth/drive"] });
  return google.drive({ version: "v3", auth });
}

const drive = await driveApi();
const folderCache = new Map();

async function ensureFolder(name) {
  if (folderCache.has(name)) return folderCache.get(name);
  const q = `'${FOLDER}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found = await drive.files.list({ q, fields: "files(id)", supportsAllDrives: true, includeItemsFromAllDrives: true });
  let id = found.data.files?.[0]?.id;
  if (!id) {
    if (!WRITE) { folderCache.set(name, "(would create)"); return "(would create)"; }
    const created = await drive.files.create({
      requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [FOLDER] },
      fields: "id",
      supportsAllDrives: true,
    });
    id = created.data.id;
  }
  folderCache.set(name, id);
  return id;
}

const { data: rows } = await db
  .from("design_images")
  .select("id, design_id, file_ref, file_name, role, status")
  .like("file_ref", "sb:%");
const { data: designs } = await db.from("designs").select("id, base_sku, color, drive_folder_id");
const designById = new Map((designs ?? []).map((d) => [d.id, d]));

let moved = 0, failed = 0, skipped = 0;
for (const row of rows ?? []) {
  const design = designById.get(row.design_id);
  if (!design) { skipped++; continue; }
  const path = row.file_ref.slice(3).includes(":") ? null : row.file_ref.slice(3);
  if (!path) { skipped++; continue; } // aux-bucket refs (notes etc.) stay in storage
  const folderName = `${design.base_sku}-${design.color.toUpperCase()}`;
  const name = row.file_name ?? path.split("/").pop();
  console.log(`${WRITE ? "→" : "would"} ${folderName}/${name}  (${row.role}${row.status !== "active" ? " · " + row.status : ""})`);
  if (!WRITE) { moved++; continue; }
  try {
    const { data: blob, error } = await db.storage.from("design-images").download(path);
    if (error || !blob) throw new Error(error?.message ?? "download failed");
    const folderId = await ensureFolder(folderName);
    const contentType = name.endsWith(".png") ? "image/png" : "image/jpeg";
    const up = await drive.files.create({
      requestBody: { name, parents: [folderId] },
      media: { mimeType: contentType, body: Readable.from(Buffer.from(await blob.arrayBuffer())) },
      fields: "id",
      supportsAllDrives: true,
    });
    await db.from("design_images").update({ file_ref: up.data.id }).eq("id", row.id);
    if (!design.drive_folder_id) {
      await db.from("designs").update({ drive_folder_id: folderId }).eq("id", design.id);
      design.drive_folder_id = folderId;
    }
    moved++;
  } catch (e) {
    failed++;
    console.log(`  FAILED: ${e.message}`);
  }
}
console.log(`\n${WRITE ? "Migrated" : "Would migrate"} ${moved} photo(s) · failed ${failed} · skipped ${skipped} (aux buckets / orphans)`);
if (!WRITE) console.log("Pass --write to commit.");

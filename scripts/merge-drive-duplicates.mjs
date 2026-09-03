/**
 * Merge duplicate design folders in wholesale_photos (Ansh, 3 Sep).
 *
 *   node scripts/merge-drive-duplicates.mjs [--write] [--prod]
 *
 * Root cause: a design with no Drive folder gets one auto-created the moment
 * something uploads or generates; if Ansh later drops HIS photo folder with
 * the same name, the design stays linked to the sparse auto-created twin —
 * his photos are invisible to the Studio and app uploads "vanish" into the
 * other folder.
 *
 * For every design whose normalised BASE-COLOR name matches MORE THAN ONE
 * folder: keep the folder the design is linked to (else the one with the most
 * files), MOVE everything from the twins into it (files and subfolders — a
 * Drive move is a parent change, ids survive so design_images refs stay
 * valid), trash the emptied twins, and point drive_folder_id at the keeper.
 * Run ingest-drive-photos afterwards to register the newly-visible files.
 * DRY-RUN by default. Idempotent — a re-run finds no duplicates.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import fs from "node:fs";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const target = args.includes("--prod") ? "prod" : "dev";
dotenv.config({ path: ".env.local" });
if (target === "dev") dotenv.config({ path: ".env.development.local", override: true });

const FOLDER = process.env.DRIVE_DESIGN_FOLDER_ID;
if (!FOLDER) { console.error("DRIVE_DESIGN_FOLDER_ID not set."); process.exit(1); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
const sa = JSON.parse(raw.startsWith("{") ? raw : fs.readFileSync(raw, "utf8"));
const auth = new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/drive"] });
const drive = google.drive({ version: "v3", auth });

console.log(`Duplicate-folder merge → ${target.toUpperCase()} ${WRITE ? "· WRITE" : "· DRY-RUN"}`);

async function listAll(q, fields) {
  const out = []; let pageToken;
  do {
    const res = await drive.files.list({ q, fields: `nextPageToken, files(${fields})`, pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

const normKey = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const folders = await listAll(`'${FOLDER}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, "id,name");
const byKey = new Map();
for (const f of folders) {
  const k = normKey(f.name);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(f);
}

const { data: designs } = await db.from("designs").select("id, base_sku, color, drive_folder_id");
const linkByKey = new Map((designs ?? []).map((d) => [normKey(`${d.base_sku}-${d.color}`), d]));

let groups = 0, moved = 0, trashed = 0;
for (const [key, list] of byKey) {
  if (list.length < 2) continue;
  groups++;
  const design = linkByKey.get(key);
  // Keeper: the linked folder when it's in this group; else the fullest one.
  const counts = new Map();
  for (const f of list) counts.set(f.id, (await listAll(`'${f.id}' in parents and trashed=false`, "id")).length);
  let keeper = design?.drive_folder_id && list.some((f) => f.id === design.drive_folder_id)
    ? list.find((f) => f.id === design.drive_folder_id)
    : [...list].sort((a, b) => counts.get(b.id) - counts.get(a.id))[0];
  const twins = list.filter((f) => f.id !== keeper.id);
  console.log(`· ${list[0].name}: ${list.length} folders — keeping ${keeper.id.slice(0, 10)} (${counts.get(keeper.id)} items), merging ${twins.map((t) => `${t.id.slice(0, 10)} (${counts.get(t.id)})`).join(", ")}`);
  for (const t of twins) {
    const children = await listAll(`'${t.id}' in parents and trashed=false`, "id,name");
    for (const c of children) {
      if (WRITE) await drive.files.update({ fileId: c.id, addParents: keeper.id, removeParents: t.id, supportsAllDrives: true, fields: "id" });
      moved++;
    }
    if (WRITE) await drive.files.update({ fileId: t.id, requestBody: { trashed: true }, supportsAllDrives: true, fields: "id" });
    trashed++;
  }
  if (design && WRITE && design.drive_folder_id !== keeper.id) {
    await db.from("designs").update({ drive_folder_id: keeper.id }).eq("id", design.id);
    console.log(`  relinked design ${design.base_sku}-${design.color} → ${keeper.id.slice(0, 10)}`);
  }
}
console.log(`\n${WRITE ? "Done" : "Would do"}: ${groups} duplicate group(s), ${moved} item(s) moved, ${trashed} twin folder(s) trashed.`);
if (groups > 0) console.log("Now run: node scripts/ingest-drive-photos.mjs --write" + (target === "prod" ? " --prod" : ""));

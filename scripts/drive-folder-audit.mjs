/**
 * Retrofit R2 §4.3 — read-only folder audit → docs/DRIVE-FOLDER-AUDIT.md.
 * Run and CLEAR this before the first upload, so Ansh renames a handful of
 * folders instead of discovering duplicates later.
 *
 *   npm run retrofit:folder-audit
 *
 * With DRIVE_DESIGN_FOLDER_ID empty the report still runs and says so — it is
 * the checklist for ANSH-19, not a blocker.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.development.local" });
dotenv.config({ path: ".env.local" });

const parent = (process.env.DRIVE_DESIGN_FOLDER_ID ?? "").trim();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: (u, i) => fetch(u, { ...i, cache: "no-store" }) },
});

const normKey = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function drive() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  const sa = JSON.parse(raw.startsWith("{") ? raw : readFileSync(raw, "utf8"));
  const auth = new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  await auth.authorize();
  return google.drive({ version: "v3", auth });
}

async function listFolders(d, id) {
  const out = [];
  let pageToken;
  do {
    const res = await d.files.list({
      q: `'${id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "nextPageToken, files(id,name)", pageSize: 1000, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

// Mirrors matchFolder() in src/lib/drive-design.ts
function match(folders, base, color) {
  const group = normKey(`${base}-${color}`);
  const exact = folders.filter((f) => normKey(f.name) === group);
  if (exact.length === 1) return { rule: "exact", folder: exact[0] };
  if (exact.length > 1) return { rule: "ambiguous", candidates: exact };
  const baseOnly = folders.filter((f) => normKey(f.name) === normKey(base));
  if (baseOnly.length === 1) return { rule: "base", folder: baseOnly[0] };
  if (baseOnly.length > 1) return { rule: "ambiguous", candidates: baseOnly };
  const variants = folders.filter((f) => {
    const n = f.name.trim().toUpperCase();
    return n.startsWith(`${base}-`) && n.endsWith(`-${color}`);
  });
  if (variants.length === 1) return { rule: "variant", folder: variants[0] };
  if (variants.length > 1) return { rule: "ambiguous", candidates: variants };
  return { rule: "none" };
}

(async () => {
  const lines = [];
  const p = (s = "") => lines.push(s);
  p("# Drive folder audit (retrofit §4.3)");
  p("");
  p(`Generated ${new Date().toISOString()}`);
  p("");

  const { data: designs } = await db.from("designs").select("id, base_sku, color, drive_folder_id").order("base_sku");
  p(`Designs: **${(designs ?? []).length}**`);
  p("");

  if (!parent) {
    p("> `DRIVE_DESIGN_FOLDER_ID` is **not set** (ANSH-19). No folder can be matched or created yet.");
    p("> Every design below therefore needs a folder once the parent is supplied.");
    p("");
    p("| Design | Group folder name to create |");
    p("|---|---|");
    for (const d of designs ?? []) p(`| \`${d.base_sku}·${d.color}\` | \`${d.base_sku}-${d.color}\` |`);
    writeFileSync("docs/DRIVE-FOLDER-AUDIT.md", lines.join("\n") + "\n");
    console.log(`No DRIVE_DESIGN_FOLDER_ID — wrote checklist of ${(designs ?? []).length} designs.`);
    return;
  }

  const d = await drive();
  const folders = await listFolders(d, parent);
  p(`Folders under the parent: **${folders.length}**`);
  p("");

  const matched = [], ambiguous = [], missing = [];
  const usedFolderIds = new Set();
  for (const design of designs ?? []) {
    const m = match(folders, design.base_sku.toUpperCase(), design.color.toUpperCase());
    if (m.rule === "ambiguous") ambiguous.push({ design, candidates: m.candidates });
    else if (m.folder) { matched.push({ design, folder: m.folder, rule: m.rule }); usedFolderIds.add(m.folder.id); }
    else missing.push(design);
  }
  const orphanFolders = folders.filter((f) => !usedFolderIds.has(f.id));

  p("## Summary");
  p("");
  p(`- matched to exactly one folder: **${matched.length}**`);
  p(`- ambiguous (never guessed — fix by renaming): **${ambiguous.length}**`);
  p(`- no folder yet: **${missing.length}**`);
  p(`- folders matching no design: **${orphanFolders.length}**`);
  p("");

  if (ambiguous.length) {
    p("## Ambiguous — resolve these before the first upload");
    p("");
    p("| Design | Candidate folders |");
    p("|---|---|");
    for (const a of ambiguous) p(`| \`${a.design.base_sku}·${a.design.color}\` | ${a.candidates.map((c) => `\`${c.name}\``).join(", ")} |`);
    p("");
  }
  p("## Matched");
  p("");
  p("| Design | Folder | Rule |");
  p("|---|---|---|");
  for (const m of matched) p(`| \`${m.design.base_sku}·${m.design.color}\` | \`${m.folder.name}\` | ${m.rule} |`);
  p("");
  if (missing.length) {
    p("## No folder (will be created on first upload)");
    p("");
    for (const m of missing) p(`- \`${m.base_sku}·${m.color}\` → \`${m.base_sku}-${m.color}\``);
    p("");
  }
  if (orphanFolders.length) {
    p("## Folders matching no design");
    p("");
    for (const f of orphanFolders) p(`- \`${f.name}\``);
    p("");
  }

  writeFileSync("docs/DRIVE-FOLDER-AUDIT.md", lines.join("\n") + "\n");
  console.log(`matched=${matched.length} ambiguous=${ambiguous.length} missing=${missing.length} orphans=${orphanFolders.length}`);
})();

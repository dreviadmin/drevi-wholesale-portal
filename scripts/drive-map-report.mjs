/**
 * Retrofit R2 §4.4 — read-only mapping report → docs/DRIVE-MAP.md.
 *
 * The app moves NOTHING. Drive file ids stay valid across folder moves, so
 * every registered file keeps resolving no matter where Ansh puts it. This
 * report exists to assist the manual consolidation: for each design it lists
 * the files the app knows about, with their CURRENT parent folder and name.
 *
 *   npm run retrofit:drive-map
 */
import { readFileSync, writeFileSync } from "node:fs";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.development.local" });
dotenv.config({ path: ".env.local" });

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: (u, i) => fetch(u, { ...i, cache: "no-store" }) },
});

(async () => {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  const sa = JSON.parse(raw.startsWith("{") ? raw : readFileSync(raw, "utf8"));
  const auth = new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  await auth.authorize();
  const drive = google.drive({ version: "v3", auth });

  const { data: designs } = await db.from("designs").select("id, base_sku, color").order("base_sku");
  const { data: images } = await db.from("design_images").select("id, design_id, angle_id, role, engine, file_ref, status").limit(5000);
  const { data: angles } = await db.from("design_angles").select("id, angle").limit(5000);
  const angleName = new Map((angles ?? []).map((a) => [a.id, a.angle]));

  const byDesign = new Map();
  for (const i of images ?? []) {
    if (!i.design_id) continue;
    byDesign.set(i.design_id, [...(byDesign.get(i.design_id) ?? []), i]);
  }

  // Cache folder names — many files share a parent.
  const folderNames = new Map();
  async function nameOf(id) {
    if (folderNames.has(id)) return folderNames.get(id);
    try {
      const r = await drive.files.get({ fileId: id, fields: "name", supportsAllDrives: true });
      folderNames.set(id, r.data.name ?? id);
    } catch {
      folderNames.set(id, "(unreachable)");
    }
    return folderNames.get(id);
  }

  const lines = [];
  const p = (s = "") => lines.push(s);
  p("# Drive map — where each design's registered files currently live");
  p("");
  p(`Generated ${new Date().toISOString()}`);
  p("");
  p("The app never moves files. Ids stay valid wherever a file is moved by hand,");
  p("so this is a consolidation aid: it says which scattered file belongs to which SKU.");
  p("");

  let resolved = 0, unreachable = 0, designsWithFiles = 0;
  for (const d of designs ?? []) {
    const imgs = byDesign.get(d.id) ?? [];
    if (imgs.length === 0) continue;
    designsWithFiles++;
    p(`## ${d.base_sku} · ${d.color}`);
    p("");
    p("| Role | Angle | Engine | File | Current folder |");
    p("|---|---|---|---|---|");
    for (const i of imgs) {
      let fileName = "(unreachable)", parentName = "—";
      try {
        const meta = await drive.files.get({ fileId: i.file_ref, fields: "name, parents", supportsAllDrives: true });
        fileName = meta.data.name ?? i.file_ref;
        const parent = (meta.data.parents ?? [])[0];
        parentName = parent ? await nameOf(parent) : "—";
        resolved++;
      } catch {
        unreachable++;
      }
      p(`| ${i.role} | ${i.angle_id ? angleName.get(i.angle_id) ?? "?" : "—"} | ${i.engine ?? "—"} | \`${fileName}\` | \`${parentName}\` |`);
    }
    p("");
  }

  lines.splice(6, 0, `Designs with registered files: **${designsWithFiles}** · files resolved: **${resolved}** · unreachable: **${unreachable}**`, "");
  writeFileSync("docs/DRIVE-MAP.md", lines.join("\n") + "\n");
  console.log(`designs=${designsWithFiles} resolved=${resolved} unreachable=${unreachable} → docs/DRIVE-MAP.md`);
})();

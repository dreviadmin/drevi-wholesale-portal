/**
 * Regenerate copy for the live Shopify products whose custom.handwork still
 * carries the manual Specs text, then push them — using the app's own
 * generateCopyForDesign and publishShopify.
 *
 *   node --experimental-strip-types --import ./scripts/lib/app-loader.mjs scripts/fix-handwork.mjs <list.json> [--push] [--only <sku>]
 */
import fs from "node:fs";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true });
// The Anthropic key the production app uses is set on Vercel, not in
// .env.local; the dev env file carries the same one for local generation.
if (!process.env.ANTHROPIC_API_KEY) dotenv.config({ path: ".env.development.local", override: false });
const { generateCopyForDesign } = await import("../src/lib/studio/copy.ts");
const { publishShopify } = await import("../src/lib/shopify.ts");
const { createClient } = await import("@supabase/supabase-js");

const [listFile] = process.argv.slice(2);
const PUSH = process.argv.includes("--push");
const only = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1] : null; })();
const list = JSON.parse(fs.readFileSync(listFile, "utf8")).filter((r) => !only || r.sku === only);
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BY = "ansh@drevifashion.com (fix-handwork script)";
// The push's audit event has a foreign key on staff_users; look the id up here
// rather than pass it in from a shell — dotenv prints a banner to stdout and a
// $(...) capture of that is banner + id, which is how the first run failed.
const { data: staffRow } = await admin.from("staff_users").select("id").eq("email", "ansh@drevifashion.com").single();
const STAFF_ID = staffRow.id;

let ok = 0, noTag = 0, pushed = 0; const problems = [];
for (const r of list) {
  process.stdout.write(`${r.sku.padEnd(16)} copy … `);
  let res;
  try { res = await generateCopyForDesign(r.design_id, BY); } catch (e) { console.log(`threw: ${e.message.slice(0, 120)}`); problems.push(`${r.sku}: ${e.message.slice(0, 80)}`); continue; }
  if (!res.ok) { console.log(`failed: ${res.error}`); problems.push(`${r.sku}: ${res.error}`); continue; }
  const { data: row } = await admin.from("design_copy").select("tags,title").eq("design_id", r.design_id).maybeSingle();
  const hw = row?.tags && !Array.isArray(row.tags) ? row.tags.handwork : null;
  if (!hw) { console.log(`generated but NO handwork tag (tags: ${JSON.stringify(row?.tags).slice(0, 60)})`); noTag++; continue; }
  ok++; process.stdout.write(`"${hw}"`);
  if (PUSH) {
    try { const p = await publishShopify(r.design_id, STAFF_ID, BY); if (p.ok) { pushed++; process.stdout.write(" · pushed"); } else { process.stdout.write(` · push failed: ${p.error}`); problems.push(`${r.sku}: push ${p.error}`); } }
    catch (e) { process.stdout.write(` · push threw: ${e.message.slice(0, 100)}`); problems.push(`${r.sku}: push ${e.message.slice(0, 80)}`); }
  }
  console.log("");
}
console.log(`\ncopy with handwork: ${ok}/${list.length} · generated without tag: ${noTag} · pushed: ${pushed}`);
if (problems.length) { console.log("problems:"); problems.forEach((p) => console.log("  " + p)); }

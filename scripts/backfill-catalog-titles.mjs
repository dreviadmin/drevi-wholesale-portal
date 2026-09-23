/**
 * Give the buyer catalog the names it already has.
 *
 * publishWholesale wrote the description and not the title, so a garment whose
 * sheet row carried no title reached the buyer catalog showing its raw SKU —
 * 32 of 125 visible products on the morning of go-live, each with a generated
 * name sitting unused in design_copy. The push is fixed; this fills in the
 * ones already live so nobody has to re-push the whole catalog.
 *
 * Only touches rows that are VISIBLE and have NO title. Never overwrites a
 * name someone chose. Dry-run by default.
 *
 *   node scripts/backfill-catalog-titles.mjs            # prod, report only
 *   node scripts/backfill-catalog-titles.mjs --write
 *   node scripts/backfill-catalog-titles.mjs --dev
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const WRITE = process.argv.includes("--write");
const DEV = process.argv.includes("--dev");
const envFile = DEV ? ".env.development.local" : ".env.local";
const env = Object.fromEntries(
  readFileSync(envFile, "utf8").split("\n").filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

// parseSku: base = first FOUR hyphen parts, colour = the LAST.
const group = (sku) => {
  const p = String(sku).toUpperCase().split("-");
  return p.length >= 5 ? `${p.slice(0, 4).join("-")}|${p[p.length - 1]}` : null;
};

const [{ data: products }, { data: designs }, { data: copies }] = await Promise.all([
  admin.from("wholesale_products").select("sku, title, buyer_visible, locked_fields").eq("buyer_visible", true).range(0, 9999),
  admin.from("designs").select("id, base_sku, color").range(0, 9999),
  admin.from("design_copy").select("design_id, title").range(0, 9999),
]);

const titleByDesign = new Map((copies ?? []).filter((c) => c.title?.trim()).map((c) => [c.design_id, c.title.trim()]));
const designByGroup = new Map((designs ?? []).map((d) => [`${d.base_sku.toUpperCase()}|${d.color.toUpperCase()}`, d.id]));

const targets = [];
for (const p of products ?? []) {
  if (p.title?.trim()) continue;                 // never overwrite a chosen name
  const g = group(p.sku);
  const designId = g ? designByGroup.get(g) : null;
  const title = designId ? titleByDesign.get(designId) : null;
  if (title) targets.push({ sku: p.sku, title, locked: Array.isArray(p.locked_fields) ? p.locked_fields : [] });
}

console.log(`${DEV ? "DEV" : "PROD"} — ${WRITE ? "WRITING" : "DRY RUN (pass --write)"}`);
console.log(`visible: ${products?.length} · untitled: ${(products ?? []).filter((p) => !p.title?.trim()).length} · nameable: ${targets.length}\n`);

for (const t of targets) {
  console.log(`  ${t.sku}  ->  ${t.title}`);
  if (!WRITE) continue;
  // Locked, like the description the push already writes: the name is an app
  // decision now and the sheet must not put the blank back.
  const locks = new Set(t.locked);
  locks.add("title");
  const { error } = await admin.from("wholesale_products")
    .update({ title: t.title, locked_fields: [...locks] })
    .eq("sku", t.sku)
    .is("title", null);
  if (error) console.error(`    ! ${error.message}`);
}
console.log("\ndone.");

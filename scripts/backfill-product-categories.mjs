/**
 * Fill blank wholesale_products.category / sub_category from the SKU.
 *
 *   node --experimental-strip-types --import ./scripts/lib/app-loader.mjs \
 *        scripts/backfill-product-categories.mjs [--prod] [--write]
 *
 * Dry-run by default; --write applies. Uses the app's OWN rule
 * (src/lib/studio/category-from-sku.ts, catalogCategoryFor) and the live
 * vocabulary (lovs + static seed), so what this writes is exactly what the
 * sheet sync now writes for a blank cell — no second implementation to drift.
 *
 * Typed sheet values are kept (the row's existing category/sub_category act
 * as "the sheet's value"); only blanks are filled. Nothing is locked: the
 * sync's fallback keeps a blank cell from blanking the column again, and a
 * value someone later types in the sheet still wins.
 *
 * ORDER MATTERS: run this only after the sync change is deployed to the
 * target, or the 10-minute sheet cron reverts every row it touches.
 */
import dotenv from "dotenv";
const PROD = process.argv.includes("--prod");
const WRITE = process.argv.includes("--write");
dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true });

const { createClient } = await import("@supabase/supabase-js");
const { loadVocab } = await import("../src/lib/sku/vocab-live.ts");
const { catalogCategoryFor } = await import("../src/lib/studio/category-from-sku.ts");

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const vocab = await loadVocab();
// PostgREST caps a single read at 1000 rows whatever range() asks for (sync.ts
// pages product_vendor_info for the same reason) — page until a short slice.
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await admin.from("wholesale_products").select("sku, category, sub_category, buyer_visible").order("sku").range(from, from + 999);
  if (error) throw error;
  rows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

const changes = [];
for (const r of rows) {
  const before = { category: r.category?.trim() || null, subCategory: r.sub_category?.trim() || null };
  if (before.category && before.subCategory) continue;
  const after = catalogCategoryFor(before, r.sku, vocab);
  if (after.category === before.category && after.subCategory === before.subCategory) continue;
  changes.push({ sku: r.sku, visible: r.buyer_visible, before, after });
}
// Residue AFTER the rule: rows the SKU cannot fully place. Two kinds, both
// worth a human look — no category at all, and a category with no sub (a sub
// code that is not under that parent in the vocab, e.g. DD-IWS-PLZ).
const residue = rows.map((r) => ({ sku: r.sku, after: catalogCategoryFor({ category: r.category?.trim() || null, subCategory: r.sub_category?.trim() || null }, r.sku, vocab) }));
const noCat = residue.filter((x) => !x.after.category);
const noSub = residue.filter((x) => x.after.category && !x.after.subCategory);

console.log(`TARGET: ${PROD ? "PRODUCTION" : "dev"} · rows=${rows.length} · to fill=${changes.length} (buyer-visible ${changes.filter((c) => c.visible).length})`);
const byCat = {};
for (const c of changes) { const k = `${c.after.category} / ${c.after.subCategory ?? "—"}`; byCat[k] = (byCat[k] ?? 0) + 1; }
for (const [k, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
console.log(`after the rule: no category=${noCat.length}` + (noCat.length ? ` (${noCat.map((x) => x.sku).join(" ")})` : "") + ` · category but no sub=${noSub.length}` + (noSub.length ? ` (${noSub.map((x) => x.sku).join(" ")})` : ""));

if (!WRITE) { console.log("\n--write not given — nothing written."); process.exit(0); }
console.log("\nWRITING. Reminder: the sheet sync (GitHub Actions, every 10 min) must already be running the SKU-fallback build on this target, or it reverts these rows. Re-run without --write after the next sync: 'to fill' must read 0.");
let done = 0; const failed = [];
for (const c of changes) {
  const { error: uErr } = await admin.from("wholesale_products").update({ category: c.after.category, sub_category: c.after.subCategory }).eq("sku", c.sku);
  if (uErr) failed.push(`${c.sku}: ${uErr.message}`); else done++;
}
console.log(`\nwritten ${done}/${changes.length}` + (failed.length ? `\nFAILED:\n  ${failed.join("\n  ")}` : ""));
process.exit(failed.length ? 1 : 0);

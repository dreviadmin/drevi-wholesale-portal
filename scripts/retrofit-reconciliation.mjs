/**
 * Retrofit R9 (spec v1.3 §11) — backfill + reconciliation.
 *
 *   node scripts/retrofit-reconciliation.mjs            # report only (dev)
 *   node scripts/retrofit-reconciliation.mjs --fix      # also create folders / link sources
 *   node scripts/retrofit-reconciliation.mjs --prod     # against production
 *
 * Writes docs/RETROFIT-RECONCILIATION.md. Read-only unless --fix is passed.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const target = process.argv.includes("--prod") ? "prod" : "dev";
const fix = process.argv.includes("--fix");
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: envFile, override: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing Supabase credentials."); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });
const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? "unknown";
console.log(`Reconciling ${target.toUpperCase()} (${ref})${fix ? " — WITH FIXES" : " — report only"}`);

/** PostgREST caps a page at 1000 rows; page through everything. */
async function all(table, columns, tweak = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tweak(db.from(table).select(columns).range(from, from + 999));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) return out;
  }
}

const sections = [];
const line = (s = "") => sections.push(s);

// ── 1 · Folders ───────────────────────────────────────────────────────────
const designs = await all("designs", "id, base_sku, color, drive_folder_id, ident_image_id, vendor_sku, origin_source");
const images = await all("design_images", "id, design_id, angle_id, role, file_ref, status");
const receiptLines = await all("goods_receipt_lines", "id, sku, design_id, vendor_sku");

const imagesByDesign = new Map();
for (const i of images) imagesByDesign.set(i.design_id, (imagesByDesign.get(i.design_id) ?? 0) + 1);
const receiptDesigns = new Set(receiptLines.map((l) => l.design_id).filter(Boolean));

const needFolder = designs.filter(
  (d) => !d.drive_folder_id && ((imagesByDesign.get(d.id) ?? 0) > 0 || receiptDesigns.has(d.id)),
);
const noContent = designs.filter((d) => (imagesByDesign.get(d.id) ?? 0) === 0 && !receiptDesigns.has(d.id));

line("## 1 · Drive folders");
line("");
line(`- Designs: **${designs.length}**`);
line(`- With a folder recorded: **${designs.filter((d) => d.drive_folder_id).length}**`);
line(`- Holding images or receipt lines but **no folder**: **${needFolder.length}**`);
line(`- Holding neither images nor receipt lines (nothing to file yet): **${noContent.length}**`);
line("");
if (needFolder.length) {
  line("Designs awaiting a folder:");
  line("");
  line("| Design | Images | Receipt lines |");
  line("|---|---|---|");
  for (const d of needFolder.slice(0, 40)) {
    line(`| ${d.base_sku} · ${d.color} | ${imagesByDesign.get(d.id) ?? 0} | ${receiptDesigns.has(d.id) ? "yes" : "—"} |`);
  }
  if (needFolder.length > 40) line(`| … ${needFolder.length - 40} more | | |`);
  line("");
  line("> Folder creation needs `DRIVE_DESIGN_FOLDER_ID` (ANSH-19). While it is unset the app never falls back to a legacy folder, so these stay unfiled by design.");
}
line("");

// ── 2 · Ident photos ──────────────────────────────────────────────────────
const angles = await all("design_angles", "id, design_id, angle, source_ref, source_image_id, approved_image_id");
const approvedByDesign = new Set(angles.filter((a) => a.approved_image_id).map((a) => a.design_id));
const noIdent = designs.filter((d) => !d.ident_image_id);
const noIdentPublished = noIdent.filter((d) => approvedByDesign.has(d.id));
const noIdentFresh = noIdent.filter((d) => !approvedByDesign.has(d.id));

line("## 2 · Ident photos");
line("");
line(`- Without an ident photo: **${noIdent.length}** of ${designs.length}`);
line(`  - already have an approved image (lower priority): **${noIdentPublished.length}**`);
line(`  - no approved image yet (shoot these first): **${noIdentFresh.length}**`);
line("");
if (noIdentFresh.length) {
  line("First 30 with nothing approved yet:");
  line("");
  line(noIdentFresh.slice(0, 30).map((d) => `\`${d.base_sku}-${d.color}\``).join(", "));
  line("");
}

// ── 3 · Source rows ───────────────────────────────────────────────────────
const imageById = new Map(images.map((i) => [i.id, i]));
const withLegacyRef = angles.filter((a) => a.source_ref);
const missingRow = [];
const mismatched = [];
for (const a of withLegacyRef) {
  const img = a.source_image_id ? imageById.get(a.source_image_id) : null;
  if (!img) { missingRow.push(a); continue; }
  if (img.file_ref !== a.source_ref) mismatched.push({ angle: a, img });
}

line("## 3 · Source rows");
line("");
line(`- Angles carrying a legacy \`source_ref\`: **${withLegacyRef.length}**`);
line(`- Without a matching \`design_images\` row / \`source_image_id\`: **${missingRow.length}**`);
line(`- Linked but pointing at a different file: **${mismatched.length}**`);
line("");
line(
  missingRow.length === 0 && mismatched.length === 0
    ? "> ✅ Every legacy source has a row. `design_angles.source_ref` is safe to drop."
    : "> ⚠ Resolve these before dropping `design_angles.source_ref` — the column is still the only record for them.",
);
if (fix && missingRow.length) {
  let linked = 0;
  for (const a of missingRow) {
    const { data: row } = await db
      .from("design_images")
      .insert({ design_id: a.design_id, angle_id: a.id, role: "source", file_ref: a.source_ref, status: "active", created_by: "reconciliation" })
      .select("id")
      .single();
    if (row) {
      await db.from("design_angles").update({ source_image_id: row.id }).eq("id", a.id);
      linked++;
    }
  }
  line("");
  line(`> **--fix**: created and linked ${linked} source row(s).`);
}
line("");

// ── 4 · Lifestyle ─────────────────────────────────────────────────────────
const anglesByDesign = new Map();
for (const a of angles) anglesByDesign.set(a.design_id, [...(anglesByDesign.get(a.design_id) ?? []), a.angle]);
const missingLifestyle = designs.filter((d) => !(anglesByDesign.get(d.id) ?? []).includes("lifestyle"));
const detached = images.filter((i) => !i.angle_id && i.role !== "ident");

line("## 4 · Lifestyle angle");
line("");
line(`- Designs missing a \`lifestyle\` angle: **${missingLifestyle.length}**`);
line(`- Images detached from closeup angles by 0023 and still unassigned: **${detached.length}**`);
line("");
line(
  missingLifestyle.length === 0
    ? "> ✅ Every design carries the full set of six."
    : `> ⚠ ${missingLifestyle.length} design(s) short a lifestyle row — re-run 0023.`,
);
line("");
if (detached.length) {
  line("> Detached images stay selectable in the Studio image picker (§7.2) — they are not lost, just unassigned.");
  line("");
}

// ── 5 · Receipt links ─────────────────────────────────────────────────────
const unresolved = receiptLines.filter((l) => !l.design_id);
line("## 5 · Receipt links");
line("");
line(`- Receipt lines: **${receiptLines.length}**`);
line(`- Whose SKU did not resolve to a design: **${unresolved.length}**`);
line("");
if (unresolved.length) {
  line("| SKU | Vendor SKU |");
  line("|---|---|");
  for (const l of unresolved.slice(0, 40)) line(`| ${l.sku ?? "—"} | ${l.vendor_sku ?? "—"} |`);
  if (unresolved.length > 40) line(`| … ${unresolved.length - 40} more | |`);
  line("");
}

// ── 6 · Ledger ────────────────────────────────────────────────────────────
const movements = await all("stock_movements", "id, sku, delta, snapshot_qty, reason, created_at");
const products = await all("wholesale_products", "sku, current_qty");
const bySku = new Map();
for (const m of movements) {
  const k = m.sku.toUpperCase();
  bySku.set(k, [...(bySku.get(k) ?? []), m]);
}
function canonical(list) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let idx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i].reason === "reset") { idx = i; break; }
  if (idx === -1) return sorted.reduce((s, m) => s + (m.delta ?? 0), 0);
  return (sorted[idx].snapshot_qty ?? 0) + sorted.slice(idx + 1).reduce((s, m) => s + (m.delta ?? 0), 0);
}
const drift = [];
for (const p of products) {
  const ledger = canonical(bySku.get(p.sku.toUpperCase()) ?? []);
  if (ledger !== (p.current_qty ?? 0)) drift.push({ sku: p.sku, cached: p.current_qty ?? 0, ledger });
}
const negatives = products.filter((p) => (p.current_qty ?? 0) < 0);

line("## 6 · Stock ledger");
line("");
line(`- SKUs checked: **${products.length}**`);
line(`- Movements: **${movements.length}**`);
line(`- Cache disagreeing with the ledger: **${drift.length}**`);
line(`- Reading negative (shipped more than the books held): **${negatives.length}**`);
line("");
line(
  drift.length === 0
    ? "> ✅ Every SKU's cached quantity equals its canonical ledger value."
    : "> ⚠ Drift present — resolve at /admin/stock-check.",
);
if (drift.length) {
  line("");
  line("| SKU | Cache | Ledger |");
  line("|---|---|---|");
  for (const d of drift.slice(0, 40)) line(`| ${d.sku} | ${d.cached} | ${d.ledger} |`);
  if (drift.length > 40) line(`| … ${drift.length - 40} more | | |`);
}
if (negatives.length) {
  line("");
  line("> Negative readings are expected while Shopify POS sales stay invisible (ANSH-18). Correct them with a stock take, not a guess.");
}
line("");

// ── 7 · Buyer safety ──────────────────────────────────────────────────────
const identIds = new Set(images.filter((i) => i.role === "ident").map((i) => i.id));
const identRefs = new Set(images.filter((i) => i.role === "ident").map((i) => i.file_ref));
const approvedIdent = angles.filter((a) => a.approved_image_id && identIds.has(a.approved_image_id));

let productImageLeaks = [];
try {
  const productImages = await all("product_images", "id, sku, file_ref");
  productImageLeaks = productImages.filter((p) => identRefs.has(p.file_ref));
} catch {
  // No product_images table in this schema — buyer images come from
  // wholesale_products.image_urls instead, checked below.
  const wp = await all("wholesale_products", "sku, image_urls, wholesale_visible");
  productImageLeaks = wp
    .filter((p) => p.wholesale_visible)
    .filter((p) => (p.image_urls ?? []).some((u) => [...identRefs].some((r) => String(u).includes(r))))
    .map((p) => ({ sku: p.sku }));
}

line("## 7 · Buyer safety");
line("");
line(`- \`role='ident'\` images: **${identIds.size}**`);
line(`- Ident images approved onto an angle (would reach a buyer): **${approvedIdent.length}**`);
line(`- Ident file refs appearing in buyer-visible product images: **${productImageLeaks.length}**`);
line("");
line(
  approvedIdent.length === 0 && productImageLeaks.length === 0
    ? "> ✅ No identification photo reaches a buyer surface."
    : "> ⚠ An ident photo is reachable from a buyer surface — fix before flipping the flag.",
);
if (productImageLeaks.length) {
  line("");
  for (const p of productImageLeaks.slice(0, 20)) line(`- \`${p.sku}\``);
}
line("");

// ── Verdict ───────────────────────────────────────────────────────────────
const blockers = [];
if (missingRow.length || mismatched.length) blockers.push(`${missingRow.length + mismatched.length} unlinked legacy source(s)`);
if (missingLifestyle.length) blockers.push(`${missingLifestyle.length} design(s) without a lifestyle angle`);
if (approvedIdent.length || productImageLeaks.length) blockers.push("an ident photo reachable from a buyer surface");
if (drift.length) blockers.push(`${drift.length} SKU(s) with ledger drift`);

const header = [
  "# Retrofit reconciliation",
  "",
  `Spec v1.3 §11 · target **${target.toUpperCase()}** (\`${ref}\`) · generated by \`npm run retrofit:reconcile\`.`,
  "",
  blockers.length === 0
    ? "## ✅ Clear to flip `RECEIPT_INTAKE_V2`"
    : `## ⚠ ${blockers.length} blocker(s) before flipping \`RECEIPT_INTAKE_V2\``,
  "",
  ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["Nothing outstanding on the checks §11 asks for."]),
  "",
  "Unresolved receipt lines and missing folders are reported but do not block: the first is data entry, the second waits on ANSH-19.",
  "",
  "---",
  "",
].join("\n");

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "..", "docs", "RETROFIT-RECONCILIATION.md");
writeFileSync(out, header + sections.join("\n") + "\n");
console.log(`Wrote ${out}`);
console.log(blockers.length === 0 ? "Clear to flip RECEIPT_INTAKE_V2." : `Blockers: ${blockers.join("; ")}`);

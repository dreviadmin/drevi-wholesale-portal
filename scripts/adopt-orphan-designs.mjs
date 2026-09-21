/**
 * Give a Studio design to catalog SKUs that have none (Ansh, 22 Sep:
 * "In case while making this change, you encounter SKUs that are there in the
 *  current catalog but not in studio: copy them to studio, else the orders
 *  using them will be affected").
 *
 * 10 such SKUs exist on prod. The instruction rests on a premise that turns out
 * to be false for most of them, so this script does NOT copy all 10:
 *
 *   - 8 are DEAD DUPLICATES of SKUs that were re-coded and already have live
 *     designs. Minting designs for them would put a second group in Studio for
 *     a garment that already has one, which is the opposite of the intent.
 *   - Only ONE of the 10 is on any order (DD-LEH-FLR-084-L-BRN), and it is one
 *     of the duplicates. Its wholesale_products row is left exactly as it is,
 *     which is what keeps its two orders resolving — a design would not have
 *     helped and a second group would have hurt.
 *   - 1 is a real garment with no successor anywhere. That one is adopted.
 *   - 1 is probably real but needs Arushi to confirm before it is minted.
 *
 * The evidence for each verdict is in the table below. Dry-run by default:
 *   node scripts/adopt-orphan-designs.mjs              # prod, report only
 *   node scripts/adopt-orphan-designs.mjs --write      # prod, apply
 *   node scripts/adopt-orphan-designs.mjs --dev        # dev database
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

const ALL_ANGLES = ["front", "back", "side", "lifestyle", "detail_1", "detail_2"];

// Matches parseSku in src/lib/studio/ingest.ts: base = first FOUR parts,
// colour = the LAST part (not the fifth — a size sits between them).
function parseSku(sku) {
  const p = String(sku).toUpperCase().split("-");
  if (p.length < 5 || !/^\d{2,4}$/.test(p[3])) return null;
  return { base: p.slice(0, 4).join("-"), color: p[p.length - 1] };
}

const ADOPT = [
  {
    sku: "DD-KUR-TUN-007-XL-CRL",
    color_name: "Coral", category: "KUR", sub_category: "TUN",
    why: "No successor anywhere. sku_registry has it from Arushi, 6 Mar 2026: 'coral pink beads zari work kurta and plazo simmer tissue'. The vendor-style collision (Viva/88490) points at a different number and colour, and 007-CRL and 008-GRN were minted the same day as a pair — sibling styles, not a re-code.",
  },
];

const SKIP = [
  ["DD-LEH-FLR-104", "no size or colour suffix — cannot parse, and DD-LEH-FLR-104-L-NVY is live with a design. A design would need an invented colour code."],
  ["DD-LEH-FLR-083-L-WHT", "superseded by DD-LEH-FLR-083-L-BRN — identical title, vendor Santlal/BMR-IVORY, cost, retail and wholesale. One ombre garment, colour corrected WHT→BRN."],
  ["DD-LEH-FLR-073-L-GLD", "superseded by DD-LEH-MRM-073-L-ROS — identical title, vendor JANAK/1497, cost, retail, wholesale. Sub-category FLR→MRM and colour GLD→ROS."],
  ["DD-SAR-PRD-053-L-RST", "superseded by DD-SAR-PRD-053-L-BGE — byte-identical title AND description, vendor Fouram/1493. Colour corrected RST→BGE."],
  ["DD-SUT-PLZ-031-XL-PUR", "superseded by DD-SAR-PRD-031-XL-PUR, live with a design, same vendor OM/5968. Category corrected SUT-PLZ→SAR-PRD."],
  ["DD-SUT-PLZ-031-XL-PNK", "superseded by DD-SAR-PRD-031-XL-PNK — byte-identical title and description, same vendor OM/5968."],
  ["DD-IWS-PLZ-027-L-GRN", "no registry row ever existed for IWS-PLZ-027; DD-SUT-PLZ-027-L-GRN is live with a design, same vendor and colour. A typo'd category prefix the sheet later fixed."],
  ["DD-LEH-FLR-084-L-BRN", "ON TWO LIVE ORDERS (DX-20260717-021 confirmed, DX-20260717-018 submitted) — its wholesale_products row is deliberately left untouched so both keep resolving. Superseded by DD-LEH-MRM-013-L-BRN (same vendor JANAK/1450, identical wholesale ₹6,300). A design here would duplicate 013|BRN. Confirm the 084→013 renumber with Arushi before any cleanup."],
  ["DD-SAR-PRD-041-L-PUR", "ASK ARUSHI. Probably real: distinct title, distinct description, its own photo, registry line from Arushi 7 May. But priced ₹0 with cost ₹0, so it cannot be sold until someone prices it. Not minted without a human saying so."],
];

const [{ data: products }, { data: designs }] = await Promise.all([
  admin.from("wholesale_products").select("sku, title, wholesale_price, current_qty").range(0, 9999),
  admin.from("designs").select("id, base_sku, color").range(0, 9999),
]);
const groups = new Set((designs ?? []).map((d) => `${d.base_sku.toUpperCase()}|${d.color.toUpperCase()}`));
const orphans = (products ?? []).filter((p) => {
  const g = parseSku(p.sku);
  return !g || !groups.has(`${g.base}|${g.color}`);
});

console.log(`${DEV ? "DEV" : "PROD"} — ${WRITE ? "WRITING" : "DRY RUN (pass --write to apply)"}`);
console.log(`wholesale_products: ${products?.length} · designs: ${designs?.length} · SKUs with no design: ${orphans.length}\n`);

const known = new Set([...ADOPT.map((a) => a.sku), ...SKIP.map((s) => s[0])]);
const unexpected = orphans.filter((o) => !known.has(o.sku.toUpperCase()));
if (unexpected.length) {
  console.log("!! SKUs with no design that this script has no verdict for — do NOT adopt blind:");
  for (const u of unexpected) console.log(`   ${u.sku}  ${u.title ?? ""}`);
  console.log("");
}

console.log("LEAVING ALONE:");
for (const [sku, why] of SKIP) {
  const present = orphans.some((o) => o.sku.toUpperCase() === sku);
  console.log(`   ${present ? "·" : "(not on this database)"} ${sku}\n       ${why}`);
}

console.log("\nADOPTING:");
for (const a of ADOPT) {
  const row = orphans.find((o) => o.sku.toUpperCase() === a.sku);
  if (!row) { console.log(`   (not on this database) ${a.sku}`); continue; }
  const g = parseSku(a.sku);
  console.log(`   ${a.sku}  →  designs(${g.base} · ${g.color})`);
  console.log(`       ${a.why}`);
  if (!WRITE) continue;

  // origin_source 'app' is deliberate: this SKU is gone from the Product
  // Master Sheet, so nothing else will ever manage it, and §3.7 skipping it in
  // the sync is the honest outcome rather than a side effect.
  const { data: design, error } = await admin.from("designs").upsert({
    base_sku: g.base, color: g.color, origin_source: "app",
    color_name: a.color_name, category: a.category, sub_category: a.sub_category,
    title: row.title ?? null,
  }, { onConflict: "base_sku,color" }).select("id").single();
  if (error) { console.error(`       ! ${error.message}`); continue; }

  const { data: have } = await admin.from("design_angles").select("angle").eq("design_id", design.id);
  const existing = new Set((have ?? []).map((x) => x.angle));
  const missing = ALL_ANGLES.filter((x) => !existing.has(x)).map((angle) => ({ design_id: design.id, angle }));
  if (missing.length) {
    const { error: aErr } = await admin.from("design_angles").insert(missing);
    if (aErr) console.error(`       ! angles: ${aErr.message}`);
  }
  // 'not_ready' on purpose. The whole point of the buyer-catalog gate is that
  // a live wholesale target is what puts a garment in front of buyers, and
  // this one has never been pushed.
  for (const portal of ["wholesale", "shopify"]) {
    const { error: tErr } = await admin.from("publish_targets")
      .upsert({ design_id: design.id, portal }, { onConflict: "design_id,portal" });
    if (tErr) console.error(`       ! ${portal} target: ${tErr.message}`);
  }
  console.log(`       created ${design.id} · ${missing.length} angle(s) · 2 targets at not_ready`);
}
console.log("\ndone.");

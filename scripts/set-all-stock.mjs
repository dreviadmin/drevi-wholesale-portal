/**
 * Set every product's stock to a fixed quantity, through the LEDGER.
 *
 *   node scripts/set-all-stock.mjs --dry-run          # dev, show the plan
 *   node scripts/set-all-stock.mjs                    # dev, apply
 *   node scripts/set-all-stock.mjs --prod --dry-run   # prod, show the plan
 *   node scripts/set-all-stock.mjs --prod             # prod, apply
 *   node scripts/set-all-stock.mjs --qty 1            # default is 1
 *   node scripts/set-all-stock.mjs --unlock           # undo the sync lock only
 *
 * TARGET SELECTION mirrors scripts/apply-migration.mjs — dev by default, prod
 * needs an explicit flag, because this rewrites the whole catalog's stock.
 *
 * WHY NOT JUST UPDATE current_qty. wholesale_products.current_qty is a CACHE of
 * the stock ledger (migration 0026). canonicalFromMovements = the latest
 * `reset` snapshot plus every delta after it, and applyMovement is the only
 * sanctioned writer. Writing the column directly would leave the cache and the
 * ledger disagreeing, which is exactly what /admin/stock-check reports as
 * drift. So this writes ONE reset movement per SKU — the same row shape
 * setStock/commitStockTake produce — and then sets the cache to match. Because
 * created_at defaults to now(), each new reset becomes the last movement for
 * its SKU, so the canonical value is the snapshot with no later deltas.
 *
 * src/lib/stock-ledger.ts is `import "server-only"`, so a node script cannot
 * import applyMovement. The row shape is duplicated here DELIBERATELY and is
 * kept identical to setStock(); if the ledger's shape ever changes, this file
 * has to change with it.
 *
 * THE SYNC LOCK. vercel.json runs /api/cron/sync-products nightly and
 * src/lib/sync.ts writes current_qty from the Google Sheet, so without a lock
 * this reset is silently reverted before morning and leaves ~240 drifted rows.
 * Adding "current_qty" to locked_fields is what makes it stick. Reversible with
 * --unlock, which restores sheet control without touching the ledger.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const target = has("--prod") || process.env.DB_TARGET === "prod" ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
const dryRun = has("--dry-run");
const unlockOnly = has("--unlock");
const qtyArg = args.indexOf("--qty");
const QTY = qtyArg >= 0 ? Number(args[qtyArg + 1]) : 1;
if (!Number.isInteger(QTY) || QTY < 0) {
  console.error("--qty must be a non-negative integer");
  process.exit(1);
}

dotenv.config({ path: envFile, override: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error(`Missing Supabase env in ${envFile}`); process.exit(1); }
const admin = createClient(url, key, { auth: { persistSession: false } });

const ref = url.match(/https:\/\/([a-z0-9]+)\./)?.[1];
console.log(`Target: ${target.toUpperCase()} (${envFile}, project ${ref})`);
console.log(dryRun ? "DRY RUN — nothing will be written\n" : "APPLYING\n");

const { data: products, error } = await admin
  .from("wholesale_products")
  .select("sku, current_qty, locked_fields")
  .order("sku");
if (error) throw error;
console.log(`${products.length} products`);

if (unlockOnly) {
  let n = 0;
  for (const p of products) {
    const locked = (p.locked_fields ?? []).filter((f) => f !== "current_qty");
    if (locked.length === (p.locked_fields ?? []).length) continue;
    n++;
    if (!dryRun) {
      const { error: e } = await admin.from("wholesale_products").update({ locked_fields: locked }).eq("sku", p.sku);
      if (e) throw e;
    }
  }
  console.log(`${dryRun ? "would unlock" : "unlocked"} current_qty on ${n} products — the nightly sheet sync controls stock again`);
  process.exit(0);
}

const needsQty = products.filter((p) => (p.current_qty ?? 0) !== QTY);
const needsLock = products.filter((p) => !(p.locked_fields ?? []).includes("current_qty"));
console.log(`  ${needsQty.length} not already at ${QTY}`);
console.log(`  ${needsLock.length} without current_qty locked (the nightly sheet sync would revert those)\n`);

if (dryRun) {
  console.log("first 5 that would change:");
  needsQty.slice(0, 5).forEach((p) => console.log(`  ${p.sku.padEnd(28)} ${p.current_qty} -> ${QTY}`));
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
const note = `Portal reset — every SKU set to ${QTY} pc (${stamp})`;
let moved = 0, cached = 0, locked = 0, failed = 0;

for (const p of products) {
  const sku = p.sku.trim().toUpperCase();
  // Same row shape as setStock(): a reset carries the absolute snapshot and a
  // zero delta; sm_reset_shape (0026) enforces exactly this pairing.
  const { error: mErr } = await admin.from("stock_movements").insert({
    sku, delta: 0, snapshot_qty: QTY, reason: "reset",
    ref_type: "bulk_set", ref_id: null, note, created_by: "ansh@drevifashion.com",
  });
  if (mErr) { console.error(`  ${sku}: movement failed — ${mErr.message}`); failed++; continue; }
  moved++;

  const nextLocked = Array.from(new Set([...(p.locked_fields ?? []), "current_qty"]));
  const { error: uErr } = await admin
    .from("wholesale_products")
    .update({ current_qty: QTY, locked_fields: nextLocked })
    .eq("sku", p.sku);
  if (uErr) { console.error(`  ${sku}: cache/lock failed — ${uErr.message}`); failed++; continue; }
  cached++;
  if (!(p.locked_fields ?? []).includes("current_qty")) locked++;
}

console.log(`\nreset movements written : ${moved}`);
console.log(`caches set to ${QTY}          : ${cached}`);
console.log(`current_qty newly locked : ${locked}`);
if (failed) console.log(`FAILURES                 : ${failed}`);

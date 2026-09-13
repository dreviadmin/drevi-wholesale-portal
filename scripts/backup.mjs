/**
 * Data-level backup: exports every portal table to a gzipped JSON file under
 * .local/backups/ and keeps the newest 14. Complements (doesn't replace)
 * Supabase Pro's point-in-time backups — this is the ₹0 safety net.
 *
 *   npm run db:backup
 *
 * portal.sh runs this once per day from its keepalive loop.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import dotenv from "dotenv";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local") });

// Mirrors BACKUP_TABLES in src/lib/backup.ts — backup-tables.test.ts fails the
// build if the two lists (or the migrations) ever drift apart again.
const TABLES = [
  "buyers",
  "staff_users",
  "auth_audit_log",
  "vendors",
  "wholesale_products",
  "product_vendor_info",
  "sync_ignored_skus",
  "sku_registry",
  "lovs",
  "product_images",
  "carts",
  "orders",
  "order_bills",
  "order_counters",
  "retail_bills",
  "credit_notes",
  "credit_ledger",
  "buyer_change_requests",
  "exhibition_sessions",
  "goods_receipts",
  "goods_receipt_lines",
  "stock_movements",
  "designs",
  "design_angles",
  "design_images",
  "design_copy",
  "image_candidates",
  "publish_targets",
  "pipeline_jobs",
  "entity_notes",
  "notify_me",
  "shopify_tokens",
];
const KEEP = 14;
const PAGE = 1000;

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", ".local", "backups");
mkdirSync(dir, { recursive: true });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function dumpTable(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from(table).select("*").range(from, from + PAGE - 1);
    if (error) {
      // Migration not run yet on this target — skip the table, keep the backup.
      if (/does not exist|schema cache/i.test(error.message)) return null;
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

const stamp = new Date().toISOString().slice(0, 10);
const out = {};
let total = 0;
for (const t of TABLES) {
  const rows = await dumpTable(t);
  if (rows === null) { console.log(`  ${t.padEnd(22)} not found — skipped (migration pending)`); continue; }
  out[t] = rows;
  total += rows.length;
  console.log(`  ${t.padEnd(22)} ${rows.length} rows`);
}

const file = join(dir, `backup-${stamp}.json.gz`);
writeFileSync(file, gzipSync(JSON.stringify({ exported_at: new Date().toISOString(), tables: out })));
console.log(`\nWrote ${file} (${Math.round(statSync(file).size / 1024)} KB, ${total} rows)`);

// prune to newest KEEP
const files = readdirSync(dir).filter((f) => f.startsWith("backup-") && f.endsWith(".json.gz")).sort();
for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
  unlinkSync(join(dir, f));
  console.log(`pruned ${f}`);
}

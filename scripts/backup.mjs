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

const TABLES = [
  "buyers",
  "orders",
  "carts",
  "staff_users",
  "exhibition_sessions",
  "auth_audit_log",
  "wholesale_products",
  "product_vendor_info",
  "sync_ignored_skus",
  "order_counters",
  "sku_registry",
  "vendors",
  "goods_receipts",
  "goods_receipt_lines",
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
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

const stamp = new Date().toISOString().slice(0, 10);
const out = {};
let total = 0;
for (const t of TABLES) {
  out[t] = await dumpTable(t);
  total += out[t].length;
  console.log(`  ${t.padEnd(22)} ${out[t].length} rows`);
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

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// Full-table export used by the backup endpoint (and mirrored by
// scripts/backup.mjs for local runs).
//
// EVERY table in supabase/migrations must appear here — backup-tables.test.ts
// parses the migrations and fails the build if one is missing. (12 Sep: the
// list had drifted badly — the whole Studio, the stock ledger, both billing
// tables and the LoVs were silently outside every backup taken since they
// were created.)
export const BACKUP_TABLES = [
  // Parties, auth and access
  "buyers",
  "agents",
  "order_agents",
  "buyer_agents",
  "agent_commissions",
  "agent_adjustments",
  "agent_payments",
  "buyer_contacts",
  "staff_users",
  "auth_audit_log",
  "vendors",
  // Catalog and vocabulary
  "wholesale_products",
  "product_vendor_info",
  "sync_ignored_skus",
  "sku_registry",
  "lovs",
  "product_images",
  // Selling: carts, orders, bills
  "carts",
  "orders",
  "order_bills",
  "order_counters",
  "retail_bills",
  "credit_notes",
  "credit_ledger",
  "buyer_change_requests",
  "exhibition_sessions",
  // Goods in and stock truth
  "goods_receipts",
  "goods_receipt_lines",
  "stock_movements",
  // Studio
  "designs",
  "design_angles",
  "design_images",
  "design_copy",
  "image_candidates",
  "publish_targets",
  "pipeline_jobs",
  // Misc
  "entity_notes",
  "notify_me",
  "shopify_tokens",
  // 0068 wallet (26 Sep) — store credit; the OTP table is short-lived but still ours to restore
  "wallet_accounts",
  "wallet_ledger",
  "wallet_otps",
  "wallet_redemptions",
  "wallet_webhook_events",
] as const;

const PAGE = 1000;

export interface BackupPayload {
  exported_at: string;
  row_count: number;
  tables: Record<string, unknown[]>;
  /** Tables skipped because they do not exist yet (migration pending). */
  warnings?: string[];
}

export async function exportAllTables(): Promise<BackupPayload> {
  const admin = createAdminClient();
  const tables: Record<string, unknown[]> = {};
  const warnings: string[] = [];
  let row_count = 0;
  for (const t of BACKUP_TABLES) {
    const rows: unknown[] = [];
    let missing = false;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.from(t).select("*").range(from, from + PAGE - 1);
      if (error) {
        // A table whose migration has not run yet (code deploys before
        // db:migrate) must not cost us the other 30 tables — the whole point
        // of this export is that it still runs on a bad day.
        if (/does not exist|schema cache/i.test(error.message)) { missing = true; break; }
        throw new Error(`${t}: ${error.message}`);
      }
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    if (missing) { warnings.push(`${t}: table not found — skipped`); continue; }
    tables[t] = rows;
    row_count += rows.length;
  }
  return { exported_at: new Date().toISOString(), row_count, tables, warnings };
}

// --- Storage backup (audit fix) ---------------------------------------------
// Visiting cards, custom-item photos and vendor bills are irreplaceable
// business records that lived ONLY in Supabase Storage — a project loss would
// have destroyed them all. Included once daily (the cron route gates on the
// IST hour) to keep free-tier egress sane; tables stay hourly.
//
// Deliberately EXCLUDED (regenerable, and large enough to matter on the free
// tier — this is a decision, not drift): `order-pdfs` re-renders from the
// order rows via renderOrderPdf, `product-photos` and `product-images` are
// mirrors of Google Drive refreshed by the sync / Re-push paths.
// `receipt-photos` is created on first bill upload (ensureBucket), so it is
// listed here before it exists and simply warns until then.
const STORAGE_BUCKETS = ["buyer-cards", "custom-items", "receipt-photos", "design-images", "vendor-photos", "order-attachments", "note-photos"] as const;

export interface StorageBackup {
  bucket: string;
  path: string;
  content_type: string | null;
  base64: string;
}

export async function exportStorage(): Promise<{ files: StorageBackup[]; warnings: string[] }> {
  const admin = createAdminClient();
  const files: StorageBackup[] = [];
  const warnings: string[] = [];
  for (const bucket of STORAGE_BUCKETS) {
    // Objects live at most one folder deep (ownerId/file) in every bucket.
    const { data: top, error } = await admin.storage.from(bucket).list("", { limit: 1000 });
    if (error) { warnings.push(`${bucket}: list failed — ${error.message}`); continue; }
    const paths: string[] = [];
    for (const entry of top ?? []) {
      if (entry.id) { paths.push(entry.name); continue; } // a file at root
      const { data: inner } = await admin.storage.from(bucket).list(entry.name, { limit: 1000 });
      for (const f of inner ?? []) if (f.id) paths.push(`${entry.name}/${f.name}`);
    }
    for (const path of paths) {
      const { data, error: dlErr } = await admin.storage.from(bucket).download(path);
      if (dlErr || !data) { warnings.push(`${bucket}/${path}: ${dlErr?.message ?? "empty"}`); continue; }
      const buf = Buffer.from(await data.arrayBuffer());
      files.push({ bucket, path, content_type: data.type || null, base64: buf.toString("base64") });
    }
  }
  return { files, warnings };
}

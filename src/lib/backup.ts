import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// Full-table export used by the backup endpoint (and mirrored by
// scripts/backup.mjs for local runs). Keep the table list in sync with the
// schema when new tables are added.
export const BACKUP_TABLES = [
  "buyers",
  "orders",
  "carts",
  "staff_users",
  "exhibition_sessions",
  "auth_audit_log",
  "wholesale_products",
  // Restore-critical config + Phase 1 tables (audit finding: these were
  // absent, making disaster recovery incomplete).
  "product_vendor_info",
  "sync_ignored_skus",
  "order_counters",
  "sku_registry",
  "vendors",
  "goods_receipts",
  "goods_receipt_lines",
] as const;

const PAGE = 1000;

export interface BackupPayload {
  exported_at: string;
  row_count: number;
  tables: Record<string, unknown[]>;
}

export async function exportAllTables(): Promise<BackupPayload> {
  const admin = createAdminClient();
  const tables: Record<string, unknown[]> = {};
  let row_count = 0;
  for (const t of BACKUP_TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.from(t).select("*").range(from, from + PAGE - 1);
      if (error) throw new Error(`${t}: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    tables[t] = rows;
    row_count += rows.length;
  }
  return { exported_at: new Date().toISOString(), row_count, tables };
}

// --- Storage backup (audit fix) ---------------------------------------------
// Visiting cards, custom-item photos and vendor bills are irreplaceable
// business records that lived ONLY in Supabase Storage — a project loss would
// have destroyed them all. Included once daily (the cron route gates on the
// IST hour) to keep free-tier egress sane; tables stay hourly.
const STORAGE_BUCKETS = ["buyer-cards", "custom-items", "receipt-photos"] as const;

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
